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
 *
 * The JSON-RPC handler ({@link handleJsonRpc}) is exported and pure over an
 * injected registry loader so it can be unit-tested; the stdio loop only
 * starts when this file is the process entry point.
 * @module
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { computeContextStrategy } from "./context-strategy.js";
import { ModelRegistry } from "./registry.js";
import { parseRouteStrategy, ROUTE_STRATEGIES } from "./registry-routing.js";
import type { ModelMode } from "./types.js";

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
					enum: ["chat", "embedding", "image", "video", "audio", "moderation", "rerank"],
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
			"Find the cheapest AI model that meets your requirements. Returns ranked matches with per-million token pricing. Use this before routing a request to pick the most cost-effective option.",
		inputSchema: {
			type: "object",
			properties: {
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
			"Rank chat-model routes by strategy: cheapest (price only), fastest (observed p95 latency), reliable (circuit-breaker state plus timeout / auth-error history), or balanced (weighted blend of all three). Providers whose breaker is open always sort last, so the result doubles as a failover order. Accepts the same filters as kosha_cheapest_model.",
		inputSchema: {
			type: "object",
			properties: {
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

async function loadRegistry(): Promise<ModelRegistry> {
	const reg = new ModelRegistry();
	await reg.discover();
	registryInstance = reg;
	return reg;
}

async function getRegistry(): Promise<ModelRegistry> {
	if (registryInstance) return registryInstance;
	registryReady ??= loadRegistry();
	return registryReady;
}

/** Production dependencies: the discover-on-first-use registry. */
const defaultDeps: McpDeps = { registry: getRegistry };

/** Thrown by a tool handler for caller mistakes (unknown tool, bad argument). */
class ToolInputError extends Error {}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps = defaultDeps): Promise<unknown> {
	const reg = await deps.registry();

	switch (name) {
		case "kosha_query_models": {
			const models = reg.models({
				provider: args.provider as string | undefined,
				mode: args.mode as ModelMode | undefined,
				capability: args.capability as string | undefined,
			});
			const limit = typeof args.limit === "number" ? args.limit : 20;
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

		case "kosha_cheapest_model": {
			const minContext =
				typeof args.min_context_k === "number" ? args.min_context_k * 1_000 : undefined;
			const result = reg.cheapestModels({
				mode: "chat",
				capability: args.capability as string | undefined,
				provider: args.provider as string | undefined,
				limit: typeof args.limit === "number" ? args.limit : 5,
			});
			const matches = minContext
				? result.matches.filter((m) => m.model.contextWindow >= minContext)
				: result.matches;
			return {
				matches: matches.map((m) => ({
					id: m.model.id,
					provider: m.model.provider,
					name: m.model.name,
					contextWindow: m.model.contextWindow,
					pricing: m.model.pricing ?? null,
					score: m.score,
					priceMetric: m.priceMetric,
				})),
				missingCredentials: result.missingCredentials.map((c) => c.providerId),
			};
		}

		case "kosha_ranked_routes": {
			const strategy = parseRouteStrategy(typeof args.strategy === "string" ? args.strategy : undefined);
			if (!strategy) {
				throw new ToolInputError(
					`unknown strategy '${String(args.strategy)}' — expected one of ${ROUTE_STRATEGIES.join(", ")}`,
				);
			}
			const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
			const minContext = typeof args.min_context_k === "number" ? args.min_context_k * 1_000 : undefined;
			const ranked = reg.rankedRoutes(
				{
					mode: "chat",
					capability: args.capability as string | undefined,
					provider: args.provider as string | undefined,
					// Over-fetch so a min-context filter applied after ranking
					// still has enough candidates to fill `limit`.
					limit: Math.max(limit * 4, 20),
				},
				strategy,
			);
			const filtered = minContext ? ranked.filter((r) => r.model.contextWindow >= minContext) : ranked;
			return {
				strategy,
				routes: filtered.slice(0, limit).map((r) => ({
					id: r.model.id,
					provider: r.providerId,
					name: r.model.name,
					contextWindow: r.model.contextWindow,
					pricing: r.model.pricing ?? null,
					price: r.price,
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
			const model = reg.model(args.model as string);
			if (!model) return { error: `model '${args.model}' not found` };
			const provider = reg.provider(model.provider);
			return {
				...model,
				baseUrl: provider?.baseUrl,
				authenticated: provider?.authenticated ?? false,
			};
		}

		case "kosha_model_routes": {
			const routes = reg.modelRouteInfo(args.model as string);
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
			const resolved = reg.resolve(args.alias as string);
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
			const list = args.provider
				? providers.filter((p) => p.id === args.provider)
				: providers;
			return list.map((p) => ({
				id: p.id,
				name: p.name,
				authenticated: p.authenticated,
				credentialSource: p.credentialSource ?? null,
				modelCount: p.models.length,
				lastRefreshed: p.lastRefreshed ?? null,
				lastError: errorByProvider.get(p.id) ?? null,
			}));
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

			const candidates = reg
				.cheapestModels({ mode: "chat", limit: 20 })
				.matches.map((m) => m.model);

			return computeContextStrategy({
				model,
				currentTokens,
				expectedRemainingTurns:
					typeof args.expected_remaining_turns === "number" ? args.expected_remaining_turns : undefined,
				expectedOutputTokens:
					typeof args.expected_output_tokens === "number" ? args.expected_output_tokens : undefined,
				candidateAlternatives: candidates,
			});
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
	const { id, method, params } = msg;

	// Notifications carry no id — no response expected.
	if (!method || method.startsWith("notifications/")) return null;

	switch (method) {
		case "initialize": {
			const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
			return ok(id, {
				protocolVersion: negotiateProtocolVersion(requested),
				capabilities: { tools: {} },
				serverInfo: { name: "kosha", version: KOSHA_MCP_VERSION },
			});
		}

		case "ping":
			return ok(id, {});

		case "tools/list":
			return ok(id, { tools: TOOLS });

		case "tools/call": {
			const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
			if (typeof call.name !== "string") {
				return fail(id, JSON_RPC.INVALID_PARAMS, "tools/call requires a string `name`");
			}
			const args =
				call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
					? (call.arguments as Record<string, unknown>)
					: {};
			try {
				const result = await callTool(call.name, args, deps);
				return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
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
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk: string) => {
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
			handleJsonRpc(parsed, deps)
				.then((response) => {
					if (response) send(response);
				})
				.catch((err) => {
					process.stderr.write(`[kosha-mcp] ${err}\n`);
				});
		}
	});

	process.stdin.on("end", () => process.exit(0));
}

// Only attach to stdio when executed directly (`kosha-mcp` bin or
// `node dist/mcp-server.js`). Resolving argv[1] through realpath keeps the
// check correct when the bin is a symlink (global npm installs), where
// argv[1] is the link path and import.meta.url is the target.
const isEntryPoint = (() => {
	try {
		return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
})();
if (isEntryPoint) runStdioServer();
