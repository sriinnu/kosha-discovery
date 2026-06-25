/**
 * kosha-discovery — OpenAI-compatible model proxy.
 *
 * Adds POST /proxy/v1/chat/completions to the Hono server.
 * The caller sets `model` to one of:
 *
 *   "claude-opus-4-7"               — any canonical model ID or alias
 *   "kosha:cheapest"                — cheapest forwardable chat model
 *   "kosha:cheapest[tool_use]"      — cheapest with that capability
 *   "kosha:cheapest[128k,vision]"   — cheapest with min context + capability
 *   "kosha:cheapest[provider:groq]" — cheapest on a specific provider
 *
 * Filters inside brackets are comma-separated and combinable:
 *   <capability>   any tag in the model card (tool_use, vision, code, …)
 *   <N>k           minimum context window in tokens
 *   provider:<id>  pin to a specific serving-layer provider
 *
 * Supported transports: openai, openai-compatible-http, ollama.
 * Anthropic, Google, Cohere, Bedrock, Vertex speak different wire formats
 * and are not yet proxied.
 *
 * Response headers added by the proxy:
 *   x-kosha-model      — resolved model ID
 *   x-kosha-provider   — resolved provider
 *   x-kosha-requested  — original model string from the caller
 * @module
 */

import type { Hono } from "hono";
import type { ModelCard } from "./types.js";
import type { ModelRegistry } from "./registry.js";
import { getProviderDescriptor, listProviderDescriptors, providerExecutionCredentialRequired } from "./provider-catalog.js";
import { fallbackRegistryCredential, getRegistryCredentialResolver } from "./registry-runtime.js";
import { parseRouteStrategy, type RouteStrategy } from "./registry-routing.js";
import {
	appendLedgerEntry,
	estimateRequestCost,
	readMonthlyBudgetUsd,
	readSpendForMonth,
} from "./cost.js";
import {
	translateAnthropicToOpenAI,
	translateOpenAIToAnthropic,
	type AnthropicMessagesResponse,
	type OpenAIChatRequest,
} from "./wire-anthropic.js";

// ---------------------------------------------------------------------------
// Upstream host allowlist (SSRF guard)
// ---------------------------------------------------------------------------

/**
 * Hostnames the proxy is allowed to forward to. Built once at module load
 * from the in-process provider catalog (NOT from any file/cache value).
 * Even though buildUpstreamUrl already only takes the host from the in-process
 * catalog for non-local providers, validating the parsed URL's hostname
 * against this list here lets static analyzers (CodeQL `js/request-forgery`)
 * recognize this code as a sanitizer for the outbound fetch.
 */
const ALLOWED_UPSTREAM_HOSTS: readonly string[] = (() => {
	const hosts = new Set<string>();
	for (const descriptor of listProviderDescriptors()) {
		try {
			hosts.add(new URL(descriptor.defaultBaseUrl).hostname);
		} catch {
			// A malformed catalog entry should not block loading the module.
		}
	}
	return Object.freeze(Array.from(hosts));
})();

/**
 * Return the upstream URL if-and-only-if its hostname is one we trust.
 * Returns null for an unparseable URL, an exotic protocol, or a hostname
 * outside the catalog allowlist / loopback families. The caller refuses the
 * request in that case rather than dialing a tainted host. Written with
 * explicit `===` checks against literal strings so static taint analysis
 * recognizes this function as a sanitizer.
 */
function safeUpstreamUrl(rawUrl: string, isLocalProvider: boolean): URL | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return null;
	}
	// Block exotic schemes that fetch would otherwise accept (data:, file:, …).
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	const host = parsed.hostname;
	if (isLocalProvider) {
		// Loopback-only for user-configurable local runtimes. Explicit literal
		// comparisons let CodeQL recognize this as a sanitizer.
		if (host === "localhost") return parsed;
		if (host === "127.0.0.1") return parsed;
		if (host === "::1") return parsed;
		if (host === "0.0.0.0") return parsed;
		return null;
	}
	// Non-local: hostname must match one drawn from the in-process catalog.
	for (const allowed of ALLOWED_UPSTREAM_HOSTS) {
		if (host === allowed) return parsed;
	}
	return null;
}

// native-http providers that speak the OpenAI wire format natively.
// All openai-compatible-http providers are implicitly forwardable.
const NATIVE_OPENAI_WIRE = new Set(["openai", "ollama"]);

// native-http providers whose wire format we translate into OpenAI-compatible
// at the proxy boundary, so the SDK contract stays OpenAI throughout.
const TRANSLATABLE_WIRE = new Set(["anthropic"]);

// ---------------------------------------------------------------------------
// Hint parsing
// ---------------------------------------------------------------------------

interface KoshaHint {
	/** Selection strategy: cheapest | fastest | reliable | balanced. */
	strategy: RouteStrategy;
	capability?: string;
	minContext?: number;
	provider?: string;
}

const KOSHA_PREFIX = "kosha:";

/**
 * Parse a `kosha:<strategy>[filters]` selector. Returns null when the model
 * string is not a kosha selector or names an unknown strategy (the caller
 * then falls through to direct model/alias resolution).
 *
 * Examples: `kosha:cheapest`, `kosha:fastest[tool_use,128k]`,
 * `kosha:reliable[provider:groq]`, `kosha:balanced[vision]`.
 */
function parseKoshaHint(model: string): KoshaHint | null {
	if (!model.startsWith(KOSHA_PREFIX)) return null;
	const rest = model.slice(KOSHA_PREFIX.length);
	const bracket = /\[([^\]]*)\]/.exec(rest);
	const head = (bracket ? rest.slice(0, bracket.index) : rest).trim();
	const strategy = parseRouteStrategy(head);
	if (!strategy) return null;

	const hint: KoshaHint = { strategy };
	if (!bracket) return hint;
	for (const part of bracket[1].split(",").map((s) => s.trim()).filter(Boolean)) {
		if (part.startsWith("provider:")) {
			hint.provider = part.slice("provider:".length);
		} else if (/^\d+k$/i.test(part)) {
			hint.minContext = Number.parseInt(part, 10) * 1_000;
		} else if (!hint.capability) {
			hint.capability = part;
		}
	}
	return hint;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function isForwardable(model: ModelCard): boolean {
	const descriptor = getProviderDescriptor(model.provider);
	if (!descriptor) return false;
	if (descriptor.transport === "openai-compatible-http") return true;
	if (descriptor.transport === "native-http") {
		return NATIVE_OPENAI_WIRE.has(model.provider) || TRANSLATABLE_WIRE.has(model.provider);
	}
	return false; // cloud-sdk (bedrock, vertex) needs per-SDK translation
}

function isExecutableRoute(registry: ModelRegistry, model: ModelCard): boolean {
	if (!isForwardable(model)) return false;
	const descriptor = getProviderDescriptor(model.provider);
	if (!descriptor || !providerExecutionCredentialRequired(descriptor)) return true;
	return registry.provider(model.provider)?.authenticated === true;
}

/**
 * Resolve an ordered list of forwardable candidate routes for `requested`.
 *
 * The order is the failover sequence: routes we hold credentials for come
 * first (ranked by the selector's strategy for kosha: hints), then any other
 * forwardable route. Duplicates (same provider + model id) are removed. An
 * empty list means nothing forwardable matched.
 */
function resolveProxyCandidates(registry: ModelRegistry, requested: string): ModelCard[] {
	const hint = parseKoshaHint(requested);
	if (hint !== null) {
		const ranked = registry.rankedRoutes({
			mode: "chat",
			capability: hint.capability,
			provider: hint.provider,
			limit: 20,
		}, hint.strategy);
		const filtered = hint.minContext
			? ranked.filter((r) => r.model.contextWindow >= (hint.minContext as number))
			: ranked;
		const exec = filtered.filter((r) => isExecutableRoute(registry, r.model)).map((r) => r.model);
		const fwd = filtered
			.filter((r) => isForwardable(r.model) && !isExecutableRoute(registry, r.model))
			.map((r) => r.model);
		return dedupeModels([...exec, ...fwd]);
	}

	// For a specific model ID or alias, prefer the canonical card but fall back
	// to any forwardable route if the primary provider isn't proxiable (e.g.
	// "claude-sonnet-4-6" resolves to Anthropic by default, but if the caller
	// only has an OpenRouter key, we should route through OpenRouter instead).
	const primary = registry.model(requested);
	const routes = registry.modelRoutes(requested);
	const ordered: ModelCard[] = [];
	if (primary && isExecutableRoute(registry, primary)) ordered.push(primary);
	for (const route of routes) if (isExecutableRoute(registry, route)) ordered.push(route);
	if (primary && isForwardable(primary)) ordered.push(primary);
	for (const route of routes) if (isForwardable(route)) ordered.push(route);
	return dedupeModels(ordered);
}

/**
 * Extract a tenant tag from an `Authorization: Bearer kosha-tenant-<name>`
 * header. We use it as a bucketing label only (per-tenant ledger rows + budget),
 * never as actual authentication — the bearer is consumed and replaced with
 * the resolved upstream credential before forwarding. Returns null for any
 * non-conforming header so downstream code doesn't have to guard for empties.
 */
function parseTenantTag(authHeader: string | undefined): string | null {
	if (!authHeader) return null;
	const match = /^\s*Bearer\s+kosha-tenant-([A-Za-z0-9_.-]{1,64})\s*$/i.exec(authHeader);
	return match ? match[1] : null;
}

/** Stable de-dup of model cards by provider + id, preserving first occurrence. */
function dedupeModels(models: ModelCard[]): ModelCard[] {
	const seen = new Set<string>();
	const out: ModelCard[] = [];
	for (const model of models) {
		const key = `${model.provider}:${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(model);
	}
	return out;
}

function resolveProxyModel(registry: ModelRegistry, requested: string): ModelCard | null {
	return resolveProxyCandidates(registry, requested)[0] ?? null;
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function buildUpstreamUrl(model: ModelCard, registry: ModelRegistry): string {
	const descriptor = getProviderDescriptor(model.provider);
	// For non-local providers we ONLY use the in-process catalog's
	// defaultBaseUrl. The registry's `baseUrl` is loaded from disk and is
	// untrusted for routing decisions; using it in the URL would let a
	// poisoned cache redirect outbound traffic (SSRF / request forgery).
	// Local providers are user-configurable, so we still let the registry
	// override the default host — but the safeUpstreamUrl() loopback check
	// in the request handler refuses anything outside the loopback families.
	let base: string;
	if (descriptor?.isLocal) {
		const info = registry.provider(model.provider);
		base = (info?.baseUrl ?? descriptor.defaultBaseUrl).replace(/\/$/, "");
	} else {
		base = (descriptor?.defaultBaseUrl ?? "").replace(/\/$/, "");
	}
	// Some native/local roots expose the OpenAI-compatible layer under /v1.
	if ((model.provider === "openai" || model.provider === "ollama" || model.provider === "llama.cpp") && !base.endsWith("/v1")) {
		return `${base}/v1/chat/completions`;
	}
	return `${base}/chat/completions`;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProxyRoutes(app: Hono, registry: ModelRegistry): void {
	// OpenAI-compatible model list — returns all models the proxy can forward.
	// Required for SDK compatibility: OpenAI clients call this before chat requests.
	app.get("/proxy/v1/models", (ctx) => {
		const models = registry.models({ mode: "chat" }).filter(isForwardable);
		return ctx.json({
			object: "list",
			data: models.map((m) => ({
				id: m.id,
				object: "model",
				created: Math.floor((m.discoveredAt ?? Date.now()) / 1000),
				owned_by: m.originProvider ?? m.provider,
			})),
		});
	});

	app.post("/proxy/v1/chat/completions", async (ctx) => {
		// ── Parse request ──────────────────────────────────────────────
		let body: Record<string, unknown>;
		try {
			body = (await ctx.req.json()) as Record<string, unknown>;
		} catch {
			return ctx.json({ error: "request body must be valid JSON" }, 400);
		}

		const requested = typeof body.model === "string" ? body.model : undefined;
		if (!requested) {
			return ctx.json({ error: "missing required field: model" }, 400);
		}

		// ── Resolve candidate routes (failover order) ──────────────────
		const candidates = resolveProxyCandidates(registry, requested);
		if (candidates.length === 0) {
			// Distinguish "found but not proxiable" (422) from "not found" (404).
			const primary = registry.model(requested);
			if (primary && !isForwardable(primary)) {
				const descriptor = getProviderDescriptor(primary.provider);
				return ctx.json(
					{
						error: `provider '${primary.provider}' uses '${descriptor?.transport ?? "unknown"}' transport — proxy not yet supported`,
						resolvedModel: primary.id,
						resolvedProvider: primary.provider,
					},
					422,
				);
			}
			return ctx.json({ error: `no model found for '${requested}'` }, 404);
		}

		// `requested` is caller-controlled. Strip control characters (CR/LF/NUL)
		// and bound the length before reflecting it into a response header:
		// the Headers constructor throws on raw CRLF, which would turn a
		// malformed model string into an unhandled 500.
		const safeRequested = requested.replace(/[\r\n\0]/g, "").slice(0, 200);

		// Optional per-tenant tag, drawn from a kosha-tenant-<name> bearer token.
		// We don't trust the value as authentication — it just buckets ledger
		// rows and per-tenant budgets. The proxy still resolves real upstream
		// credentials from env / CLI files as usual.
		const tenant = parseTenantTag(ctx.req.header("authorization"));

		// ── Budget gate ────────────────────────────────────────────────
		// When a budget is configured we MUST fail closed: if the ledger is
		// unreadable (permissions, FS error, partial mount) we cannot prove the
		// caller is under budget, so we refuse. Treating the read failure as
		// $0 spent would let an attacker bypass the cap by corrupting the
		// ledger file.
		const budget = readMonthlyBudgetUsd();
		if (budget !== null) {
			let spent: number;
			try {
				spent = await readSpendForMonth(Date.now(), tenant);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return ctx.json(
					{
						error: "budget enforcement unavailable — ledger could not be read",
						detail: message,
						budgetUsd: budget,
					},
					503,
				);
			}
			if (spent >= budget) {
				return ctx.json(
					{ error: "monthly budget exceeded", spentUsd: spent, budgetUsd: budget },
					429,
					{
						"x-kosha-budget-remaining-usd": Math.max(0, budget - spent).toFixed(4),
						"x-kosha-budget-usd": budget.toFixed(2),
					},
				);
			}
		}

		// Use the full 5-tier CredentialResolver (CLI files, ADC, OAuth, env vars)
		// so the proxy honours the same credential sources as discovery.
		const resolver = await getRegistryCredentialResolver();

		// ── Forward, failing over on transport / 5xx errors ────────────
		// We try ranked candidates in order, bounding the number of actual
		// upstream fetches so a wave of dead providers can't stall the caller.
		// A 4xx is the caller's own fault (bad request, bad key) and is returned
		// as-is; a 5xx or network error rolls over to the next candidate.
		const MAX_FETCHES = 3;
		const attemptChain: string[] = [];
		let fetchAttempts = 0;
		let lastNoCred: { provider: string; envHint: string | undefined } | null = null;
		let sawCredentialedRoute = false;

		for (const model of candidates) {
			const credential = resolver
				? await resolver.resolve(model.provider)
				: fallbackRegistryCredential(model.provider);
			const bearerToken = credential.apiKey ?? credential.accessToken;
			const descriptor = getProviderDescriptor(model.provider);
			if (descriptor && providerExecutionCredentialRequired(descriptor) && !bearerToken) {
				const envHint = descriptor.credentialEnvVars.length
					? descriptor.credentialEnvVars.join(" or ")
					: descriptor.primaryCredentialEnvVar;
				lastNoCred = { provider: model.provider, envHint };
				attemptChain.push(`${model.provider}:no-credential`);
				continue; // can't call this provider — try the next route
			}
			sawCredentialedRoute = true;
			if (fetchAttempts >= MAX_FETCHES) break;
			fetchAttempts += 1;

			const upstreamUrl = buildUpstreamUrl(model, registry);
			// The proxy never forwards to a host outside the in-process catalog
			// allowlist. The registry's `provider.baseUrl` is loaded from disk
			// cache (or could come from a user config file), so a poisoned
			// value must NOT redirect a request to an attacker-chosen host —
			// this is the SSRF / `js/request-forgery` guard.
			const safeUrl = safeUpstreamUrl(upstreamUrl, descriptor?.isLocal === true);
			if (!safeUrl) {
				attemptChain.push(`${model.provider}:untrusted-host`);
				continue;
			}
			const usesAnthropicWire = model.provider === "anthropic";
			const upstreamHeaders: Record<string, string> = { "content-type": "application/json" };
			let upstreamBody: string;
			let upstreamUrlString: string;
			if (usesAnthropicWire) {
				// Anthropic /v1/messages: auth via x-api-key + anthropic-version,
				// body translated from OpenAI chat-completions on the way in,
				// response translated back on the way out. Streaming is not yet
				// supported through the translator — fall through cleanly with a
				// 422 so the caller switches to a non-translated route.
				if (body.stream === true) {
					return ctx.json(
						{
							error: "anthropic streaming through the OpenAI-compatible proxy is not yet supported",
							resolvedModel: model.id,
							resolvedProvider: model.provider,
						},
						422,
					);
				}
				upstreamHeaders["x-api-key"] = bearerToken ?? "";
				upstreamHeaders["anthropic-version"] = "2023-06-01";
				upstreamBody = JSON.stringify(
					translateOpenAIToAnthropic({ ...(body as unknown as OpenAIChatRequest), model: model.id }),
				);
				// Rebuild the URL via the WHATWG URL API rather than a string
				// `replace`, so the pathname swap can't be tripped by a fragment
				// or query-string that happens to contain `/chat/completions`.
				// `safeUrl` is already allowlist-validated, so reusing its
				// origin keeps the SSRF guarantee intact.
				const anthropicUrl = new URL(safeUrl.toString());
				anthropicUrl.pathname = "/v1/messages";
				upstreamUrlString = anthropicUrl.toString();
			} else {
				if (bearerToken) upstreamHeaders.authorization = `Bearer ${bearerToken}`;
				upstreamBody = JSON.stringify({ ...body, model: model.id });
				upstreamUrlString = safeUrl.toString();
			}

			let upstream: Response;
			try {
				upstream = await fetch(upstreamUrlString, {
					method: "POST",
					headers: upstreamHeaders,
					body: upstreamBody,
				});
			} catch (err) {
				attemptChain.push(`${model.provider}:error`);
				if (fetchAttempts < MAX_FETCHES) continue; // fail over
				const message = err instanceof Error ? err.message : String(err);
				return ctx.json(
					{ error: `upstream unreachable: ${message}`, resolvedProvider: model.provider, attemptChain },
					502,
				);
			}

			// A retryable upstream failure (5xx) rolls over to the next route,
			// unless we've spent our fetch budget — then we surface it.
			if (upstream.status >= 500 && fetchAttempts < MAX_FETCHES) {
				attemptChain.push(`${model.provider}:${upstream.status}`);
				await upstream.body?.cancel().catch(() => {});
				continue;
			}

			attemptChain.push(`${model.provider}:${upstream.status}`);

			// Pre-flight cost estimate. We compute (input tokens × inputRate +
			// expected_output × outputRate) and reflect it on the response so the
			// caller can audit before paying. The same number is appended to the
			// ledger so kosha spend can roll it up. We do NOT block on cost here
			// — the budget gate above already short-circuited if applicable.
			const estimate = estimateRequestCost(model, body);
			const responseHeaders = new Headers({
				"x-kosha-model": model.id,
				"x-kosha-provider": model.provider,
				"x-kosha-requested": safeRequested,
				"x-kosha-attempt-chain": attemptChain.join(",").replace(/[\r\n\0]/g, "").slice(0, 400),
			});
			if (estimate) {
				responseHeaders.set("x-kosha-estimated-cost-usd", estimate.estimatedUsd.toFixed(6));
				// Best-effort ledger append. Failures here are observability
				// losses, never a reason to fail the request itself.
				appendLedgerEntry({
					ts: Date.now(),
					provider: model.provider,
					modelId: model.id,
					requested: safeRequested,
					tenant,
					estimatedUsd: estimate.estimatedUsd,
					estimatedInputTokens: estimate.inputTokens,
					estimatedOutputTokens: estimate.expectedOutputTokens,
					upstreamStatus: upstream.status,
				}).catch(() => {});
			}
			if (usesAnthropicWire && upstream.ok) {
				// Translate the JSON body back to OpenAI chat-completions shape
				// so the caller's SDK keeps working unchanged.
				let raw: AnthropicMessagesResponse;
				try {
					raw = (await upstream.json()) as AnthropicMessagesResponse;
				} catch {
					return ctx.json(
						{ error: "anthropic upstream returned unparseable JSON", resolvedProvider: model.provider },
						502,
					);
				}
				const translated = translateAnthropicToOpenAI(raw, model.id);
				responseHeaders.set("content-type", "application/json");
				return new Response(JSON.stringify(translated), { status: upstream.status, headers: responseHeaders });
			}
			const ct = upstream.headers.get("content-type");
			if (ct) responseHeaders.set("content-type", ct);
			return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
		}

		// Exhausted candidates without a returnable response.
		if (!sawCredentialedRoute && lastNoCred) {
			return ctx.json(
				{
					error: `no credential found for '${lastNoCred.provider}'`,
					hint: lastNoCred.envHint ? `set ${lastNoCred.envHint}` : "configure credentials for this provider",
					resolvedProvider: lastNoCred.provider,
					attemptChain,
				},
				401,
			);
		}
		return ctx.json({ error: "all upstream providers failed", attemptChain }, 502);
	});
}
