#!/usr/bin/env node
/**
 * kosha-discovery — MCP server (stdio transport, protocol 2024-11-05).
 *
 * Exposes the local kosha registry as MCP tools so AI agents can query
 * model pricing, routing, and health without HTTP.
 *
 * Tools:
 *   kosha_query_models      — list / filter models
 *   kosha_cheapest_model    — cheapest model meeting requirements
 *   kosha_model_detail      — full detail for one model
 *   kosha_model_routes      — all provider routes for a model
 *   kosha_resolve_alias     — alias → canonical ID
 *   kosha_provider_health   — provider auth + error status
 * @module
 */

import { ModelRegistry } from "./registry.js";
import type { ModelMode } from "./types.js";

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: string | number | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Tool definitions (MCP schema)
// ---------------------------------------------------------------------------

const TOOLS = [
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
		name: "kosha_model_detail",
		description:
			"Get full details for a specific model — pricing, capabilities, context window, tool dialect, structured output modes, status, and deprecation info.",
		inputSchema: {
			type: "object",
			properties: {
				model: {
					type: "string",
					description: "Model ID or alias (e.g. sonnet, claude-sonnet-4-6, gpt-4o, deepseek-v3)",
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
] as const;

// ---------------------------------------------------------------------------
// Registry — lazy-load on first tool call so starting the MCP server has no
// filesystem/network side effects until a client actually asks for data.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	const reg = await getRegistry();

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

		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

// ---------------------------------------------------------------------------
// Stdio JSON-RPC loop
// ---------------------------------------------------------------------------

function send(msg: JsonRpcMessage): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id: string | number | null | undefined, result: unknown): void {
	send({ jsonrpc: "2.0", id: id ?? null, result });
}

function respondError(id: string | number | null | undefined, code: number, message: string): void {
	send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handleMessage(msg: JsonRpcMessage): Promise<void> {
	const { id, method, params } = msg;

	// Notifications carry no id — no response expected.
	if (!method || method.startsWith("notifications/")) return;

	switch (method) {
		case "initialize":
			respond(id, {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "kosha", version: "1.0.0" },
			});
			return;

		case "tools/list":
			respond(id, { tools: TOOLS });
			return;

		case "tools/call": {
			const { name, arguments: args = {} } = params as {
				name: string;
				arguments?: Record<string, unknown>;
			};
			try {
				const result = await callTool(name, args as Record<string, unknown>);
				respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				respondError(id, -32603, message);
			}
			return;
		}

		default:
			respondError(id, -32601, `method not found: ${method}`);
	}
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			handleMessage(JSON.parse(trimmed) as JsonRpcMessage).catch((err) => {
				process.stderr.write(`[kosha-mcp] ${err}\n`);
			});
		} catch {
			// malformed JSON — ignore
		}
	}
});

process.stdin.on("end", () => process.exit(0));
