/**
 * MCP server — JSON-RPC dispatch over an injected fixture registry.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
	handleJsonRpc,
	type JsonRpcMessage,
	KOSHA_MCP_VERSION,
	MCP_PROTOCOL_VERSIONS,
	negotiateProtocolVersion,
	TOOLS,
	type McpDeps,
} from "../src/mcp-server.js";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

function makeModel(overrides: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
	return {
		name: overrides.id,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		...overrides,
	};
}

function makeProvider(id: string, models: ModelCard[]): ProviderInfo {
	return {
		id,
		name: id,
		baseUrl: `https://api.${id}.com`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
	};
}

const registry = ModelRegistry.fromJSON({
	providers: [
		makeProvider("groq", [
			makeModel({ id: "llama-cheap", provider: "groq", pricing: { inputPerMillion: 0.01, outputPerMillion: 0.02 } }),
		]),
		makeProvider("deepinfra", [
			makeModel({
				id: "llama-big",
				provider: "deepinfra",
				contextWindow: 1_000_000,
				pricing: { inputPerMillion: 1, outputPerMillion: 2 },
			}),
		]),
	],
	aliases: { cheap: "llama-cheap" },
	discoveredAt: Date.now(),
});
const deps: McpDeps = { registry: async () => registry };

/** Unwrap a successful JSON-RPC result, failing loudly on a null / error response. */
function resultOf<T>(res: JsonRpcMessage | null): T {
	if (!res || res.result === undefined) throw new Error(`expected a result, got ${JSON.stringify(res)}`);
	return res.result as T;
}

async function call(name: string, args: Record<string, unknown>) {
	const res = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, deps);
	const text = resultOf<{ content: Array<{ text: string }> }>(res).content[0].text;
	return { res, data: JSON.parse(text) };
}

describe("MCP initialize / ping", () => {
	it("reports the package version, not a hardcoded string", () => {
		const require = createRequire(import.meta.url);
		const pkg = require("../package.json") as { version: string };
		expect(KOSHA_MCP_VERSION).toBe(pkg.version);
	});

	it("echoes a supported client protocol version and falls back to the newest otherwise", async () => {
		expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
		expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
		expect(negotiateProtocolVersion("1999-01-01")).toBe(MCP_PROTOCOL_VERSIONS[0]);
		expect(negotiateProtocolVersion(undefined)).toBe(MCP_PROTOCOL_VERSIONS[0]);

		const res = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-03-26" } },
			deps,
		);
		const result = resultOf<{ protocolVersion: string; serverInfo: { name: string; version: string } }>(res);
		expect(result.protocolVersion).toBe("2025-03-26");
		expect(result.serverInfo).toEqual({ name: "kosha", version: KOSHA_MCP_VERSION });
	});

	it("answers ping with an empty result", async () => {
		const res = await handleJsonRpc({ jsonrpc: "2.0", id: "p", method: "ping" }, deps);
		expect(res).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
	});

	it("returns null for notifications and -32601 for unknown methods", async () => {
		expect(await handleJsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, deps)).toBeNull();
		const res = await handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "resources/list" }, deps);
		expect(res?.error?.code).toBe(-32601);
	});
});

describe("MCP tools", () => {
	it("lists kosha_ranked_routes alongside the existing tools", async () => {
		const res = await handleJsonRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, deps);
		const names = resultOf<{ tools: Array<{ name: string }> }>(res).tools.map((t) => t.name);
		expect(names).toContain("kosha_ranked_routes");
		expect(names).toContain("kosha_cheapest_model");
		expect(names).toHaveLength(TOOLS.length);
	});

	it("resolves aliases through the injected registry", async () => {
		const { data } = await call("kosha_resolve_alias", { alias: "cheap" });
		expect(data).toMatchObject({ alias: "cheap", resolved: "llama-cheap", isAlias: true, provider: "groq" });
	});

	it("ranks routes by strategy and applies the min-context filter", async () => {
		const cheapest = await call("kosha_ranked_routes", { strategy: "cheapest" });
		expect(cheapest.data.strategy).toBe("cheapest");
		expect(cheapest.data.routes[0]).toMatchObject({ id: "llama-cheap", provider: "groq" });
		expect(cheapest.data.routes[0].health).toMatchObject({ available: true, breakerState: "closed" });

		const big = await call("kosha_ranked_routes", { strategy: "balanced", min_context_k: 500 });
		expect(big.data.routes.map((r: { id: string }) => r.id)).toEqual(["llama-big"]);
	});

	it("rejects an unknown strategy or tool as invalid params (-32602)", async () => {
		const bad = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kosha_ranked_routes", arguments: { strategy: "turbo" } } },
			deps,
		);
		expect(bad?.error?.code).toBe(-32602);
		expect(bad?.error?.message).toMatch(/cheapest, fastest, reliable, balanced/);

		const unknown = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "kosha_nope", arguments: {} } },
			deps,
		);
		expect(unknown?.error?.code).toBe(-32602);
	});

	it("surfaces tool execution failures as isError results, not protocol errors", async () => {
		const failing: McpDeps = {
			registry: async () => {
				throw new Error("discovery exploded");
			},
		};
		const res = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "kosha_query_models", arguments: {} } },
			failing,
		);
		expect(res?.error).toBeUndefined();
		const result = resultOf<{ isError: boolean; content: Array<{ text: string }> }>(res);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/discovery exploded/);
	});
});
