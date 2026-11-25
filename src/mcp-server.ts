#!/usr/bin/env node
/**
 * kosha-discovery — MCP server (stdio transport).
 *
 * Exposes the local kosha registry as MCP tools so AI agents can query
 * model pricing, routing, and health without HTTP.
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdio. The server speaks
 * every MCP revision in {@link MCP_PROTOCOL_VERSIONS} and echoes the
 * client's requested revision back when it is one of them (otherwise it
 * answers with the newest it supports, per the MCP negotiation rule).
 *
 * Tools:
 *   kosha_query_models      — list / filter models
 *   kosha_cheapest_model    — cheapest model meeting requirements
 *   kosha_ranked_routes     — strategy-ranked routes (cheapest / fastest / reliable / balanced)
 *   kosha_model_detail      — full detail for one model
 *   kosha_model_routes      — all provider routes for a model
 *   kosha_resolve_alias     — alias → canonical ID
 *   kosha_provider_health   — provider auth + error status
 *   kosha_context_strategy  — context-management advice for a long conversation
 *   kosha_newest_models     — the newest models, newest first
 *
 * The JSON-RPC handler ({@link handleJsonRpc}) is exported and pure over an
 * injected registry loader so it can be unit-tested; the stdio loop only
 * starts when this file is the process entry point.
 * @module
 */

import { createRequire } from "node:module";
import { computeContextStrategy } from "./context-strategy.js";
import { isMainModule } from "./entry.js";
import { newestModels } from "./newest.js";
import { resolvePricing } from "./pricing-resolve.js";
import { getProviderCacheBehavior, normalizeProviderId } from "./provider-catalog.js";
import { ModelRegistry } from "./registry.js";
import { parseRouteStrategy, ROUTE_STRATEGIES } from "./registry-routing.js";
import { redactSecrets } from "./security.js";
import { routeAccessHint } from "./route-access.js";
import type { ModelMode, RouteAccess } from "./types.js";

// ---------------------------------------------------------------------------
// Server identity + protocol negotiation
// ---------------------------------------------------------------------------

/** Package version, read from package.json so `serverInfo.version` never drifts from the release. */
export const KOSHA_MCP_VERSION: string = (() => {
	try {
		const require = createRequire(import.meta.url);
		return (require("../package.json") as { version: string }).version;
	} catch {
		return "0.0.0";
	}
})();

/** MCP protocol revisions this server implements, newest first. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * Pick the protocol revision to answer an `initialize` with: the client's
 * own when we support it, otherwise our newest (the client then decides
 * whether to proceed).
 */
export function negotiateProtocolVersion(requested: unknown): string {
	if (typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested)) return requested;
	return MCP_PROTOCOL_VERSIONS[0];
}

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

export interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: string | number | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

/** Standard JSON-RPC 2.0 error codes used by this server. */
const JSON_RPC = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const;

// ---------------------------------------------------------------------------
// Tool definitions (MCP schema)
// ---------------------------------------------------------------------------

export const TOOLS = [
	{
		name: "kosha_query_models",
		description:
			"List AI models from the local kosha registry. Optionally filter by provider, mode, or capability tag. Returns id, provider, name, mode, context window, capabilities, and pricing.",
		inputSchema: {
			type: "object",
			properties: {
				provider: { type: "string", description: "Provider ID (e.g. anthropic, openai, groq, openrouter)" },
				mode: {
					type: "string",
					enum: ["chat", "embedding", "image", "video", "audio", "moderation", "rerank", "judgment"],
					description: "Primary model mode",
				},
				capability: {
					type: "string",
					description: "Capability tag (e.g. vision, tool_use, code, reasoning)",
				},
				limit: { type: "number", description: "Max results to return (default 20)" },
			},
		},
	},
	{
		name: "kosha_cheapest_model",
		description:
			"Find the cheapest AI model you can call now (a key it accepted, or a local runtime that answered) that meets your requirements. Returns ranked matches with per-million token pricing. When a cheaper route needs a key you don't have, it comes back as cheapestOverall with a toCall hint naming the env var. Models a subscription plan already pays for come back separately in includedInPlans, never ranked as free. Use this before routing a request to pick the most cost-effective option.",
		inputSchema: {
			type: "object",
			properties: {
				include_uncallable: {
					type: "boolean",
					description:
						"Also rank routes you can't call now (no key, a refused key, a runtime that is down); each row says callable and why not. Default false.",
				},
				capability: {
					type: "string",
					description: "Required capability (e.g. tool_use, vision, code, reasoning)",
				},
				min_context_k: {
					type: "number",
					description: "Minimum context window in thousands of tokens (e.g. 128 means 128k)",
				},
				provider: { type: "string", description: "Pin to a specific provider" },
				limit: { type: "number", description: "Number of ranked results (default 5)" },
			},
		},
	},
	{
		name: "kosha_ranked_routes",
		description:
			"Rank chat-model routes you can call now by strategy: cheapest (price only), fastest (observed p95 latency), reliable (circuit-breaker state plus timeout / auth-error history), or balanced (weighted blend of all three). Providers whose breaker is open always sort last, so the result doubles as a failover order. Accepts the same filters as kosha_cheapest_model, include_uncallable included.",
		inputSchema: {
			type: "object",
			properties: {
				include_uncallable: {
					type: "boolean",
					description: "Also rank routes you can't call now; each row says callable and why not. Default false.",
				},
				strategy: {
					type: "string",
					enum: ["cheapest", "fastest", "reliable", "balanced"],
					description: "Ranking strategy",
				},
				capability: { type: "string", description: "Required capability tag (e.g. tool_use, vision)" },
				min_context_k: { type: "number", description: "Minimum context window in thousands of tokens" },
				provider: { type: "string", description: "Pin to a specific provider" },
				limit: { type: "number", description: "Number of ranked results (default 5)" },
			},
			required: ["strategy"],
		},
	},
	{
		name: "kosha_model_detail",
		description:
			"Get full details for a specific model — pricing, capabilities, context window, tool dialect, structured output modes, status, and deprecation info.",
		inputSchema: {
			type: "object",
			properties: {
				model: {
					type: "string",
					description: "Model ID or alias (e.g. sonnet, claude-sonnet-5, gpt-4o, deepseek-v3)",
				},
			},
			required: ["model"],
		},
	},
	{
		name: "kosha_newest_models",
		description:
			"The newest models, newest first, one row per model on its maker's own route. A model with no catalog release date is dated by another route that has one, then by the day kosha first saw it; `dateSource` says which. Use it to answer 'what's new' or to check that a just-released model is known.",
		inputSchema: {
			type: "object",
			properties: {
				days: { type: "number", description: "Window in days (default 30)" },
				limit: { type: "number", description: "Maximum rows (default 25)" },
				provider: { type: "string", description: "Only this serving provider" },
				mode: { type: "string", description: "Only this mode (chat, embedding, image, ...)" },
				include_resellers: { type: "boolean", description: "Every route, not just the maker's (default false)" },
			},
		},
	},
	{
		name: "kosha_model_routes",
		description:
			"List all serving-layer routes for a model (direct provider, OpenRouter, Bedrock, Vertex, etc.) with pricing per route. Useful for finding the cheapest or most available path to a specific model.",
		inputSchema: {
			type: "object",
			properties: {
				model: { type: "string", description: "Model ID or alias" },
			},
			required: ["model"],
		},
	},
	{
		name: "kosha_resolve_alias",
		description: "Resolve a model alias or short name to its canonical ID and provider.",
		inputSchema: {
			type: "object",
			properties: {
				alias: {
					type: "string",
					description: "Short name or alias (e.g. sonnet, opus, haiku, gpt-4o-mini, gemini-flash)",
				},
			},
			required: ["alias"],
		},
	},
	{
		name: "kosha_provider_health",
		description:
			"Get authentication and health status for all discovered providers. Shows which providers are active, which need credentials, and any recent discovery errors.",
		inputSchema: {
			type: "object",
			properties: {
				provider: { type: "string", description: "Filter to a specific provider ID" },
			},
		},
	},
	{
		name: "kosha_context_strategy",
		description:
			"Advise on context management for a long-running conversation. Given a model and current token usage, returns ranked options (continue, enable prompt cache, compact + continue, switch to long-context tier, switch model, batch offload) with rough cost-per-turn math. Useful before deciding whether to summarize, swap models, or just keep going.",
		inputSchema: {
			type: "object",
			properties: {
				model: { type: "string", description: "Model ID or alias the caller is currently using" },
				current_tokens: { type: "number", description: "Approximate token count of the conversation so far" },
				expected_output_tokens: {
					type: "number",
					description: "Tokens the next reply is expected to produce (default 1024)",
				},
				expected_remaining_turns: {
					type: "number",
					description: "How many more turns the caller plans (default 5)",
				},
			},
			required: ["model", "current_tokens"],
		},
	},
	{
		name: "kosha_compare_models",
		description:
			"Compare two or more models side-by-side: resolved pricing (active tier/band/schedule), context window, max output, capabilities, prompt-cache behavior, and lifecycle status.",
		inputSchema: {
			type: "object",
			properties: {
				models: {
					type: "array",
					items: { type: "string" },
					description: "List of model IDs, aliases, or provider/model pairs to compare",
				},
			},
			required: ["models"],
		},
	},
	{
		name: "kosha_estimate_cost",
		description:
			"Estimate the USD cost of a single request for a model given input, output, cache-read, and cache-write token counts (applying long-context bands, active schedules, and optional service_tier).",
		inputSchema: {
			type: "object",
			properties: {
				model: { type: "string", description: "Model ID or alias" },
				input_tokens: { type: "number", description: "Uncached input token count" },
				output_tokens: { type: "number", description: "Output token count (default 0)" },
				cache_read_tokens: { type: "number", description: "Cached input tokens read (default 0)" },
				cache_write_tokens: { type: "number", description: "Cached input tokens written (default 0)" },
				service_tier: { type: "string", description: "Optional service tier (e.g. flex, priority)" },
			},
			required: ["model", "input_tokens"],
		},
	},
	{
		name: "kosha_pricing_anomalies",
		description: "List unexpected (>25%) pricing changes detected across catalog refreshes.",
		inputSchema: {
			type: "object",
			properties: {
				provider: { type: "string", description: "Filter anomalies to a serving provider ID" },
				limit: { type: "number", description: "Maximum number of anomalies to return (default 50)" },
			},
		},
	},
	{
		name: "kosha_list_providers",
		description:
			"List all discovered providers with model counts, credential status, prompt-cache behavior, and runtime circuit-breaker health.",
		inputSchema: {
			type: "object",
			properties: {
				authenticated_only: { type: "boolean", description: "Only return authenticated providers (default false)" },
			},
		},
	},
	{
		name: "kosha_refresh_registry",
		description:
			"Force a live refresh of the registry cache (all providers or a single provider ID) and report updated counts and any redacted errors.",
		inputSchema: {
			type: "object",
			properties: {
				provider: { type: "string", description: "Optional provider ID to scope the refresh" },
			},
		},
	},
] as const;

export const RESOURCES = [
	{
		uri: "kosha://snapshot",
		name: "Discovery Snapshot (v1)",
		description: "Full canonical v1 discovery snapshot JSON across all providers and models.",
		mimeType: "application/json",
	},
	{
		uri: "kosha://providers",
		name: "Providers & Cache Behavior",
		description: "Discovered providers with auth status, cache behavior, and route health.",
		mimeType: "application/json",
	},
	{
		uri: "kosha://anomalies",
		name: "Pricing Anomalies",
		description: "Recorded >25% pricing-diff events from manifest merges.",
		mimeType: "application/json",
	},
] as const;

// ---------------------------------------------------------------------------
// Registry — lazy-load on first tool call so starting the MCP server has no
// filesystem/network side effects until a client actually asks for data.
// ---------------------------------------------------------------------------

/** Dependencies the JSON-RPC handler needs; injected so tests can supply a fixture registry. */
export interface McpDeps {
	registry: () => Promise<ModelRegistry>;
}

let registryInstance: ModelRegistry | null = null;
let registryReady: Promise<ModelRegistry> | null = null;

/** The access fields every MCP route row carries; uncallable rows also say why and what to set. */
function accessFields(route: Partial<RouteAccess> & { model: { provider: string } }): Pick<
	RouteAccess,
	"callable" | "credentialSource" | "keyVerified"
> & {
	uncallableReason?: RouteAccess["uncallableReason"];
	toCall?: string;
} {
	const access: RouteAccess = {
		callable: route.callable ?? false,
		credentialSource: route.credentialSource ?? "none",
		keyVerified: route.keyVerified ?? false,
		...(route.uncallableReason ? { uncallableReason: route.uncallableReason } : {}),
	};
	const toCall = routeAccessHint(route.model.provider, access);
	return { ...access, ...(toCall ? { toCall } : {}) };
}

async function loadRegistry(): Promise<ModelRegistry> {
	const reg = new ModelRegistry(await ModelRegistry.loadConfigFile());
	await reg.discover();
	registryInstance = reg;
	return reg;
}

const MAX_TOOL_LIMIT = 200;
const MAX_STDIO_BUFFER_BYTES = 10 * 1024 * 1024;

function clampLimit(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(Math.max(1, Math.floor(value)), MAX_TOOL_LIMIT)
		: fallback;
}

async function getRegistry(): Promise<ModelRegistry> {
	if (registryInstance) {
		const ttl = registryInstance.toJSON().providers.length > 0 ? 86_400_000 : 0;
		const discoveredAt = registryInstance.toJSON().discoveredAt;
		if (discoveredAt > 0 && ttl > 0 && Date.now() - discoveredAt > ttl) {
			void registryInstance.refresh().catch(() => {});
		}
		return registryInstance;
	}
	if (!registryReady) {
		registryReady = loadRegistry().catch((err) => {
			registryReady = null;
			throw err;
		});
	}
	return registryReady;
}

/** Production dependencies: the discover-on-first-use registry. */
const defaultDeps: McpDeps = { registry: getRegistry };

/** Thrown by a tool handler for caller mistakes (unknown tool, bad argument). */
class ToolInputError extends Error {}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export async function callTool(
	name: string,
	args: Record<string, unknown>,
	deps: McpDeps = defaultDeps,
): Promise<unknown> {
	const reg = await deps.registry();

	switch (name) {
		case "kosha_query_models": {
			const models = reg.models({
				provider: args.provider as string | undefined,
				mode: args.mode as ModelMode | undefined,
				capability: args.capability as string | undefined,
			});
			const limit = clampLimit(args.limit, 20);
			return models.slice(0, limit).map((m) => ({
				id: m.id,
				provider: m.provider,
				name: m.name,
				mode: m.mode,
				contextWindow: m.contextWindow,
				capabilities: m.capabilities,
				pricing: m.pricing ?? null,
			}));
		}

		case "kosha_newest_models": {
			const limit = clampLimit(args.limit, 25);
			return newestModels(reg.models(), {
				days: typeof args.days === "number" && args.days > 0 ? args.days : 30,
				limit,
				provider: typeof args.provider === "string" ? args.provider : undefined,
				mode: typeof args.mode === "string" ? args.mode : undefined,
				includeResellers: args.include_resellers === true,
			}).map((row) => ({
				date: row.date,
				dateSource: row.dateSource,
				id: row.model.id,
				provider: row.model.provider,
				name: row.model.name,
				mode: row.model.mode,
				contextWindow: row.model.contextWindow,
				pricing: row.model.pricing ?? null,
				alsoOn: row.alsoOn,
			}));
		}

		case "kosha_cheapest_model": {
			const minContext = typeof args.min_context_k === "number" ? args.min_context_k * 1_000 : undefined;
			const includeUncallable = args.include_uncallable === true;
			const query = {
				mode: "chat" as const,
				capability: args.capability as string | undefined,
				provider: args.provider as string | undefined,
				minContextWindow: minContext,
			};
			// An agent acts on row one, so by default every row is one it can call.
			const result = reg.cheapestModels({
				...query,
				limit: clampLimit(args.limit, 5),
				callableOnly: !includeUncallable,
			});
			const row = (m: (typeof result.matches)[number]) => ({
				id: m.model.id,
				provider: m.model.provider,
				name: m.model.name,
				contextWindow: m.model.contextWindow,
				pricing: m.model.pricing ?? null,
				score: m.score,
				priceMetric: m.priceMetric,
				...(m.priceUnverified ? { priceUnverified: true } : {}),
				...accessFields(m),
			});
			// The market's cheapest route, when it is one you can't call: what
			// a key would buy, and which key.
			const overall = includeUncallable ? undefined : reg.cheapestModels({ ...query, limit: 1 }).matches[0];
			// Only when it is actually cheaper than the best route you can call.
			const bestCallable = result.matches[0]?.score ?? Number.POSITIVE_INFINITY;
			const cheapestOverall =
				overall && overall.callable === false && (overall.score ?? Number.POSITIVE_INFINITY) < bestCallable
					? row(overall)
					: undefined;
			return {
				matches: result.matches.map(row),
				...(cheapestOverall ? { cheapestOverall } : {}),
				...(result.matches.length === 0 && !includeUncallable
					? {
							message:
								"No route you can call matches. cheapestOverall and missingCredentials say what a key would add; include_uncallable lists everything.",
						}
					: {}),
				missingCredentials: result.missingCredentials.map((c) => c.providerId),
				// Paid by a subscription: no per-token price, and not free either.
				includedInPlans: result.includedInPlans.map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					contextWindow: m.contextWindow,
				})),
			};
		}

		case "kosha_ranked_routes": {
			const strategy = parseRouteStrategy(typeof args.strategy === "string" ? args.strategy : undefined);
			if (!strategy) {
				throw new ToolInputError(
					`unknown strategy '${String(args.strategy)}' — expected one of ${ROUTE_STRATEGIES.join(", ")}`,
				);
			}
			const limit = clampLimit(args.limit, 5);
			const minContext = typeof args.min_context_k === "number" ? args.min_context_k * 1_000 : undefined;
			const includeUncallable = args.include_uncallable === true;
			const ranked = reg.rankedRoutes(
				{
					mode: "chat",
					capability: args.capability as string | undefined,
					provider: args.provider as string | undefined,
					minContextWindow: minContext,
					limit,
					callableOnly: !includeUncallable,
				},
				strategy,
			);
			return {
				strategy,
				...(ranked.length === 0 && !includeUncallable
					? {
							message: "No route you can call matches; include_uncallable lists every route and what each needs.",
							missingCredentials: reg.missingCredentialPrompts().map((c) => c.providerId),
						}
					: {}),
				routes: ranked.map((r) => ({
					id: r.model.id,
					provider: r.providerId,
					name: r.model.name,
					contextWindow: r.model.contextWindow,
					pricing: r.model.pricing ?? null,
					price: r.price,
					...(r.priceUnverified ? { priceUnverified: true } : {}),
					...accessFields(r),
					compositeScore: r.compositeScore,
					health: {
						available: r.health.available,
						breakerState: r.health.breakerState,
						reliabilityScore: r.health.reliabilityScore,
						p95LatencyMs: r.health.p95LatencyMs,
						samples: r.health.samples,
						lastErrorType: r.health.lastErrorType,
					},
				})),
			};
		}

		case "kosha_model_detail": {
			if (typeof args.model !== "string" || args.model.trim().length === 0) {
				throw new ToolInputError("model must be a non-empty string");
			}
			const model = reg.model(args.model);
			if (!model) return { error: `model '${args.model}' not found` };
			const provider = reg.provider(model.provider);
			return {
				...model,
				baseUrl: provider?.baseUrl,
				authenticated: provider?.authenticated ?? false,
			};
		}

		case "kosha_model_routes": {
			if (typeof args.model !== "string" || args.model.trim().length === 0) {
				throw new ToolInputError("model must be a non-empty string");
			}
			const routes = reg.modelRouteInfo(args.model);
			if (routes.length === 0) return { error: `model '${args.model}' not found` };
			return routes.map((r) => ({
				provider: r.provider,
				modelId: r.model.id,
				baseUrl: r.baseUrl,
				isDirect: r.isDirect,
				isPreferred: r.isPreferred,
				pricing: r.model.pricing ?? null,
				originPricing: r.model.originPricing ?? null,
			}));
		}

		case "kosha_resolve_alias": {
			if (typeof args.alias !== "string" || args.alias.trim().length === 0) {
				throw new ToolInputError("alias must be a non-empty string");
			}
			const resolved = reg.resolve(args.alias);
			const model = reg.model(resolved);
			return {
				alias: args.alias,
				resolved,
				isAlias: resolved !== args.alias,
				provider: model?.provider ?? null,
				name: model?.name ?? null,
			};
		}

		case "kosha_provider_health": {
			const providers = reg.providers_list();
			const errors = reg.discoveryErrors();
			const errorByProvider = new Map(errors.map((e) => [e.providerId, e.error]));
			const list = args.provider ? providers.filter((p) => p.id === args.provider) : providers;
			return list.map((p) => {
				const err = errorByProvider.get(p.id);
				return {
					id: p.id,
					name: p.name,
					authenticated: p.authenticated,
					credentialSource: p.credentialSource ?? null,
					modelCount: p.models.length,
					lastRefreshed: p.lastRefreshed ?? null,
					lastError: err ? redactSecrets(err) : null,
				};
			});
		}

		case "kosha_context_strategy": {
			const modelId = args.model as string | undefined;
			if (!modelId) return { error: "model is required" };
			const currentTokens = typeof args.current_tokens === "number" ? args.current_tokens : undefined;
			if (currentTokens === undefined || currentTokens < 0) {
				return { error: "current_tokens must be a non-negative number" };
			}
			const model = reg.model(modelId);
			if (!model) return { error: `model '${modelId}' not found` };

			// Alternatives must hold the conversation, so that filter goes into
			// the query; filtering the 20 cheapest after the fact found none.
			const candidates = reg
				.cheapestModels({ mode: "chat", minContextWindow: currentTokens, limit: 20 })
				.matches.map((m) => m.model);

			return computeContextStrategy({
				model,
				currentTokens,
				expectedRemainingTurns:
					typeof args.expected_remaining_turns === "number" ? args.expected_remaining_turns : undefined,
				expectedOutputTokens: typeof args.expected_output_tokens === "number" ? args.expected_output_tokens : undefined,
				candidateAlternatives: candidates,
			});
		}

		case "kosha_compare_models": {
			if (!Array.isArray(args.models) || args.models.length === 0) {
				throw new ToolInputError("models must be a non-empty array of model IDs or aliases");
			}
			const requestedList = args.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
			if (requestedList.length === 0) {
				throw new ToolInputError("models must contain at least one non-empty string");
			}
			return {
				models: requestedList.map((requested) => {
					const m = reg.model(requested);
					if (!m) return { requested, found: false };
					const resolved = m.pricing ? resolvePricing(m.pricing) : null;
					return {
						requested,
						found: true,
						id: m.id,
						name: m.name,
						provider: m.provider,
						originProvider: m.originProvider ?? m.provider,
						mode: m.mode,
						contextWindow: m.contextWindow,
						maxOutputTokens: m.maxOutputTokens,
						capabilities: m.capabilities,
						pricing: m.pricing ?? null,
						resolvedPricing: resolved,
						cacheBehavior: getProviderCacheBehavior(m.provider) ?? null,
						status: m.status ?? "active",
						deprecationDate: m.deprecationDate ?? null,
						replacedBy: m.replacedBy ?? null,
					};
				}),
			};
		}

		case "kosha_estimate_cost": {
			if (typeof args.model !== "string" || args.model.trim().length === 0) {
				throw new ToolInputError("model is required");
			}
			const model = reg.model(args.model);
			if (!model) return { error: `model '${args.model}' not found` };
			if (!model.pricing) return { error: `model '${model.id}' has no pricing data` };
			const readNonNeg = (raw: unknown, name: string, fallback: number | undefined = 0): number => {
				if (raw === undefined) {
					if (fallback === undefined) throw new ToolInputError(`${name} must be a non-negative finite number`);
					return fallback;
				}
				if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
					throw new ToolInputError(`${name} must be a non-negative finite number`);
				}
				return raw;
			};
			const inputTokens = readNonNeg(args.input_tokens, "input_tokens", undefined);
			const outputTokens = readNonNeg(args.output_tokens, "output_tokens", 0);
			const cacheReadTokens = readNonNeg(args.cache_read_tokens, "cache_read_tokens", 0);
			const cacheWriteTokens = readNonNeg(args.cache_write_tokens, "cache_write_tokens", 0);
			const serviceTier =
				typeof args.service_tier === "string" && args.service_tier.trim().length > 0
					? args.service_tier.trim()
					: undefined;
			const serviceTierApplied = Boolean(serviceTier && model.pricing.serviceTiers?.[serviceTier]);
			const resolved = resolvePricing(model.pricing, {
				promptTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
				...(serviceTier ? { serviceTier } : {}),
			});
			const inputUsd = (inputTokens * resolved.inputPerMillion) / 1_000_000;
			const outputUsd = (outputTokens * resolved.outputPerMillion) / 1_000_000;
			const listedRead = resolved.cacheReadPerMillion;
			const cacheReadRate =
				typeof listedRead === "number" && (listedRead > 0 || resolved.inputPerMillion === 0)
					? listedRead
					: resolved.inputPerMillion;
			const cacheWriteRate = resolved.cacheWritePerMillion ?? resolved.inputPerMillion;
			const cacheReadUsd = (cacheReadTokens * cacheReadRate) / 1_000_000;
			const cacheWriteUsd = (cacheWriteTokens * cacheWriteRate) / 1_000_000;
			return {
				model: model.id,
				provider: model.provider,
				currency: resolved.currency ?? "USD",
				...(serviceTierApplied ? { serviceTier } : {}),
				appliedBand: resolved.band
					? { aboveInputTokens: resolved.band.aboveInputTokens, inclusive: resolved.band.inclusive === true }
					: null,
				inputUsd,
				outputUsd,
				cacheReadUsd,
				cacheWriteUsd,
				totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
			};
		}

		case "kosha_pricing_anomalies": {
			const limit = clampLimit(args.limit, 50);
			const providerFilter =
				typeof args.provider === "string" && args.provider.trim().length > 0
					? (normalizeProviderId(args.provider) ?? args.provider.trim())
					: undefined;
			let anomalies = await reg.pricingAnomalies();
			if (providerFilter) {
				const prefix = `${providerFilter}:`;
				anomalies = anomalies.filter((a) => a.key.startsWith(prefix));
			}
			const recent = anomalies.slice(-limit).reverse();
			return { count: recent.length, total: anomalies.length, anomalies: recent };
		}

		case "kosha_list_providers": {
			const authenticatedOnly = args.authenticated_only === true;
			const providers = reg.providers_list().filter((p) => !authenticatedOnly || p.authenticated);
			return {
				count: providers.length,
				providers: providers.map((p) => ({
					id: p.id,
					name: p.name,
					authenticated: p.authenticated,
					credentialSource: p.credentialSource ?? null,
					modelCount: p.models.length,
					lastRefreshed: p.lastRefreshed ?? null,
					cacheBehavior: getProviderCacheBehavior(p.id) ?? null,
					health: reg.providerRouteHealth(p.id),
				})),
			};
		}

		case "kosha_refresh_registry": {
			if (args.provider !== undefined && (typeof args.provider !== "string" || args.provider.trim().length === 0)) {
				throw new ToolInputError("provider must be a non-empty string when provided");
			}
			const provider = typeof args.provider === "string" ? args.provider.trim() : undefined;
			await reg.refresh(provider);
			const errors = reg.discoveryErrors().map((e) => ({ ...e, error: redactSecrets(e.error) }));
			return {
				refreshedAt: Date.now(),
				...(provider ? { provider } : {}),
				providerCount: reg.providers_list().length,
				modelCount: reg.models().length,
				errors,
			};
		}

		default:
			throw new ToolInputError(`unknown tool: ${name}`);
	}
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch (pure) + stdio loop (entry point only)
// ---------------------------------------------------------------------------

function ok(id: JsonRpcMessage["id"], result: unknown): JsonRpcMessage {
	return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(id: JsonRpcMessage["id"], code: number, message: string): JsonRpcMessage {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Handle one JSON-RPC request and return the response, or `null` for
 * notifications (which carry no id and expect no reply).
 *
 * Tool *execution* failures come back as a successful `tools/call` result
 * with `isError: true`, per the MCP spec, so the model can read the message
 * and recover; only protocol-level problems (unknown method, unknown tool,
 * malformed params) surface as JSON-RPC errors.
 */
export async function handleJsonRpc(msg: JsonRpcMessage, deps: McpDeps = defaultDeps): Promise<JsonRpcMessage | null> {
	if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
		return fail(null, JSON_RPC.INVALID_REQUEST, "Invalid Request");
	}
	const { id, method, params, jsonrpc } = msg;
	if (jsonrpc !== undefined && jsonrpc !== "2.0") {
		return fail(id ?? null, JSON_RPC.INVALID_REQUEST, "Invalid Request");
	}
	if (typeof method !== "string" || method.length === 0) {
		return fail(id ?? null, JSON_RPC.INVALID_REQUEST, "Invalid Request");
	}

	// Notifications carry no id — no response expected.
	if (method.startsWith("notifications/")) return null;

	switch (method) {
		case "initialize": {
			const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
			return ok(id, {
				protocolVersion: negotiateProtocolVersion(requested),
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: "kosha", version: KOSHA_MCP_VERSION },
			});
		}

		case "ping":
			return ok(id, {});

		case "resources/list":
			return ok(id, { resources: RESOURCES });

		case "resources/read": {
			const uri = (params as { uri?: unknown } | undefined)?.uri;
			if (typeof uri !== "string" || uri.length === 0) {
				return fail(id, JSON_RPC.INVALID_PARAMS, "resources/read requires a string `uri`");
			}
			try {
				const reg = await deps.registry();
				let payload: unknown;
				if (uri === "kosha://snapshot") {
					payload = reg.discoverySnapshot();
				} else if (uri === "kosha://providers") {
					payload = reg.providers_list().map((p) => ({
						id: p.id,
						name: p.name,
						authenticated: p.authenticated,
						modelCount: p.models.length,
						cacheBehavior: getProviderCacheBehavior(p.id) ?? null,
						health: reg.providerRouteHealth(p.id),
					}));
				} else if (uri === "kosha://anomalies") {
					payload = await reg.pricingAnomalies();
				} else {
					return fail(id, JSON_RPC.INVALID_PARAMS, `unknown resource uri: ${uri}`);
				}
				return ok(id, {
					contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
				});
			} catch (err) {
				const rawMessage = err instanceof Error ? err.message : String(err);
				return fail(id, JSON_RPC.INTERNAL_ERROR, redactSecrets(rawMessage));
			}
		}

		case "tools/list":
			return ok(id, { tools: TOOLS });

		case "tools/call": {
			const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
			if (typeof call.name !== "string") {
				return fail(id, JSON_RPC.INVALID_PARAMS, "tools/call requires a string `name`");
			}
			if (
				call.arguments !== undefined &&
				(typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments))
			) {
				return fail(id, JSON_RPC.INVALID_PARAMS, "tools/call `arguments` must be an object");
			}
			const args = (call.arguments as Record<string, unknown> | undefined) ?? {};
			try {
				const result = await callTool(call.name, args, deps);
				return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
			} catch (err) {
				const rawMessage = err instanceof Error ? err.message : String(err);
				const message = redactSecrets(rawMessage);
				if (err instanceof ToolInputError) return fail(id, JSON_RPC.INVALID_PARAMS, message);
				return ok(id, { content: [{ type: "text", text: message }], isError: true });
			}
		}

		default:
			return fail(id, JSON_RPC.METHOD_NOT_FOUND, `method not found: ${method}`);
	}
}

function send(msg: JsonRpcMessage): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** Start the newline-delimited JSON-RPC loop over stdio. */
export function runStdioServer(deps: McpDeps = defaultDeps): void {
	let buffer = "";
	/** In-flight requests, so an EOF on stdin waits for their answers before exiting. */
	const pending = new Set<Promise<void>>();
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk: string) => {
		if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_STDIO_BUFFER_BYTES) {
			buffer = "";
			send(fail(null, JSON_RPC.INVALID_REQUEST, "Request frame exceeds maximum buffer size"));
			return;
		}
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let parsed: JsonRpcMessage;
			try {
				parsed = JSON.parse(trimmed) as JsonRpcMessage;
			} catch {
				// Malformed JSON. Per JSON-RPC 2.0 we must still answer with a
				// -32700 Parse error so the client doesn't block forever waiting
				// on a response. The id is unknowable from unparseable input, so
				// per spec we respond with id=null (we deliberately avoid scanning
				// the raw text for an id, which would mean running a regex over
				// uncontrolled stdin).
				send(fail(null, JSON_RPC.PARSE_ERROR, "Parse error"));
				continue;
			}
			const job = handleJsonRpc(parsed, deps)
				.then((response) => {
					if (response) send(response);
				})
				.catch((err) => {
					process.stderr.write(`[kosha-mcp] ${err}\n`);
				})
				.finally(() => {
					pending.delete(job);
				});
			pending.add(job);
		}
	});

	// One-shot / piped clients half-close stdin right after writing their
	// request; exiting immediately would drop the answer still being computed.
	process.stdin.on("end", () => {
		Promise.allSettled(pending).then(() => process.exit(0));
	});
}

// Only attach to stdio when executed directly (`kosha-mcp` bin or
// `node dist/mcp-server.js`); see entry.ts for why realpath matters.
if (isMainModule(import.meta.url)) runStdioServer();
