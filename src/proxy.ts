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
import { getProviderDescriptor, providerExecutionCredentialRequired } from "./provider-catalog.js";
import { fallbackRegistryCredential, getRegistryCredentialResolver } from "./registry-runtime.js";

// native-http providers that speak the OpenAI wire format natively.
// All openai-compatible-http providers are implicitly forwardable.
const NATIVE_OPENAI_WIRE = new Set(["openai", "ollama"]);

// ---------------------------------------------------------------------------
// Hint parsing
// ---------------------------------------------------------------------------

interface KoshaHint {
	capability?: string;
	minContext?: number;
	provider?: string;
}

function parseKoshaHint(model: string): KoshaHint | null {
	if (!model.startsWith("kosha:cheapest")) return null;
	const m = /\[([^\]]*)\]/.exec(model);
	if (!m) return {};
	const hint: KoshaHint = {};
	for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
		if (part.startsWith("provider:")) {
			hint.provider = part.slice(9);
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
	if (descriptor.transport === "native-http") return NATIVE_OPENAI_WIRE.has(model.provider);
	return false; // cloud-sdk (bedrock, vertex) needs per-SDK translation
}

function isExecutableRoute(registry: ModelRegistry, model: ModelCard): boolean {
	if (!isForwardable(model)) return false;
	const descriptor = getProviderDescriptor(model.provider);
	if (!descriptor || !providerExecutionCredentialRequired(descriptor)) return true;
	return registry.provider(model.provider)?.authenticated === true;
}

function resolveProxyModel(registry: ModelRegistry, requested: string): ModelCard | null {
	const hint = parseKoshaHint(requested);
	if (hint !== null) {
		const result = registry.cheapestModels({
			mode: "chat",
			capability: hint.capability,
			provider: hint.provider,
			limit: 20,
		});
		const candidates = hint.minContext
			? result.matches.filter((m) => m.model.contextWindow >= (hint.minContext as number))
			: result.matches;
		// Only pick a provider we can actually forward to.
		return candidates.find((m) => isExecutableRoute(registry, m.model))?.model ??
			candidates.find((m) => isForwardable(m.model))?.model ??
			null;
	}

	// For a specific model ID or alias, prefer the canonical card but fall back
	// to any forwardable route if the primary provider isn't proxiable (e.g.
	// "claude-sonnet-4-6" resolves to Anthropic by default, but if the caller
	// only has an OpenRouter key, we should route through OpenRouter instead).
	const primary = registry.model(requested);
	if (primary && isExecutableRoute(registry, primary)) return primary;

	const routes = registry.modelRoutes(requested);
	return routes.find((route) => isExecutableRoute(registry, route)) ??
		(primary && isForwardable(primary) ? primary : undefined) ??
		routes.find(isForwardable) ??
		primary ??
		null;
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function buildUpstreamUrl(model: ModelCard, registry: ModelRegistry): string {
	const info = registry.provider(model.provider);
	const descriptor = getProviderDescriptor(model.provider);
	const base = (
		descriptor?.isLocal
			? info?.baseUrl ?? descriptor.defaultBaseUrl
			: descriptor?.defaultBaseUrl ?? info?.baseUrl ?? ""
	).replace(/\/$/, "");
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

		// ── Resolve model ──────────────────────────────────────────────
		const model = resolveProxyModel(registry, requested);
		if (!model) {
			return ctx.json({ error: `no model found for '${requested}'` }, 404);
		}

		if (!isForwardable(model)) {
			const descriptor = getProviderDescriptor(model.provider);
			return ctx.json(
				{
					error: `provider '${model.provider}' uses '${descriptor?.transport ?? "unknown"}' transport — proxy not yet supported`,
					resolvedModel: model.id,
					resolvedProvider: model.provider,
				},
				422,
			);
		}

		// ── Resolve credential ─────────────────────────────────────────
		// Use the full 5-tier CredentialResolver (CLI files, ADC, OAuth, env vars)
		// so the proxy honours the same credential sources as discovery.
		const resolver = await getRegistryCredentialResolver();
		const credential = resolver
			? await resolver.resolve(model.provider)
			: fallbackRegistryCredential(model.provider);
		const bearerToken = credential.apiKey ?? credential.accessToken;
		const credentialDescriptor = getProviderDescriptor(model.provider);
		if (credentialDescriptor && providerExecutionCredentialRequired(credentialDescriptor) && !bearerToken) {
			const envHint = credentialDescriptor.credentialEnvVars.length
				? credentialDescriptor.credentialEnvVars.join(" or ")
				: credentialDescriptor.primaryCredentialEnvVar;
			return ctx.json(
				{
					error: `no credential found for '${model.provider}'`,
					hint: envHint ? `set ${envHint}` : "configure credentials for this provider",
					resolvedModel: model.id,
					resolvedProvider: model.provider,
				},
				401,
			);
		}

		// ── Forward ────────────────────────────────────────────────────
		const upstreamUrl = buildUpstreamUrl(model, registry);
		const upstreamHeaders: Record<string, string> = { "content-type": "application/json" };
		if (bearerToken) upstreamHeaders.authorization = `Bearer ${bearerToken}`;

		let upstream: Response;
		try {
			upstream = await fetch(upstreamUrl, {
				method: "POST",
				headers: upstreamHeaders,
				body: JSON.stringify({ ...body, model: model.id }),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return ctx.json({ error: `upstream unreachable: ${message}`, resolvedProvider: model.provider }, 502);
		}

		// ── Stream response back ───────────────────────────────────────
		// `requested` is caller-controlled. Strip control characters (CR/LF/NUL)
		// and bound the length before reflecting it into a response header:
		// the Headers constructor throws on raw CRLF, which would turn a
		// malformed model string into an unhandled 500.
		const safeRequested = requested.replace(/[\r\n\0]/g, "").slice(0, 200);
		const responseHeaders = new Headers({
			"x-kosha-model": model.id,
			"x-kosha-provider": model.provider,
			"x-kosha-requested": safeRequested,
		});
		const ct = upstream.headers.get("content-type");
		if (ct) responseHeaders.set("content-type", ct);

		return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
	});
}
