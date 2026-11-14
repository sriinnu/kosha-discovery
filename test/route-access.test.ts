/**
 * Which routes you can call. kosha lists every route whether or not you hold
 * a key; each route says `callable`, and agents (MCP) and the proxy act on
 * callable routes first. Up to 1.15 `authenticated` stood in for "callable",
 * and it was true for a key the provider had just refused (stale cache) and
 * for a Claude subscription token, which the proxy never sends.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleJsonRpc, type McpDeps } from "../src/mcp-server.js";
import { ModelRegistry } from "../src/registry.js";
import { providerAccess, routeAccessHint } from "../src/route-access.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const saved = {
	KOSHA_LEDGER_PATH: process.env.KOSHA_LEDGER_PATH,
	KOSHA_PROXY_TOKEN: process.env.KOSHA_PROXY_TOKEN,
	KOSHA_MONTHLY_BUDGET_USD: process.env.KOSHA_MONTHLY_BUDGET_USD,
	GROQ_API_KEY: process.env.GROQ_API_KEY,
	TOGETHER_API_KEY: process.env.TOGETHER_API_KEY,
};
const originalFetch = globalThis.fetch;
let ledgerDir = "";

beforeEach(async () => {
	ledgerDir = await mkdtemp(join(tmpdir(), "kosha-ledger-"));
	process.env.KOSHA_LEDGER_PATH = join(ledgerDir, "ledger.jsonl");
});

afterEach(async () => {
	await rm(ledgerDir, { recursive: true, force: true });
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

function card(id: string, provider: string, price: number, extra: Partial<ModelCard> = {}): ModelCard {
	return {
		id,
		name: id,
		provider,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 32_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing: { inputPerMillion: price, outputPerMillion: price },
		...extra,
	};
}

function provider(id: string, models: ModelCard[], extra: Partial<ProviderInfo> = {}): ProviderInfo {
	return {
		id,
		name: id,
		baseUrl: `https://api.${id}.example/v1`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
		...extra,
	};
}

/** A refused key served from the last good cache: discovery keeps `authenticated: true`. */
const refused = (models: ModelCard[]) =>
	provider("together", models, { degradedReason: "Together API error: 401 Unauthorized", degradedSource: "cache" });

function registry(...providers: ProviderInfo[]): ModelRegistry {
	return ModelRegistry.fromJSON({ providers, aliases: {}, discoveredAt: Date.now() });
}

async function mcp(reg: ModelRegistry, name: string, args: Record<string, unknown>) {
	const deps: McpDeps = { registry: async () => reg };
	const res = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, deps);
	if (!res?.result) throw new Error(`no result from ${name}: ${JSON.stringify(res?.error)}`);
	return JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
}

describe("providerAccess", () => {
	it("a key whose live list answered is callable and verified", () => {
		const access = providerAccess("groq", provider("groq", [card("m", "groq", 1, { source: "api" })]));
		expect(access).toEqual({ callable: true, credentialSource: "env", keyVerified: true });
	});

	it("a key never tested against a live list is callable but unchecked", () => {
		expect(providerAccess("groq", provider("groq", [card("m", "groq", 1)]))).toMatchObject({
			callable: true,
			keyVerified: false,
		});
	});

	it("no key: not callable, and the hint names the env var", () => {
		const access = providerAccess("together", provider("together", [], { authenticated: false, credentialSource: "none" }));
		expect(access).toMatchObject({ callable: false, uncallableReason: "no-key" });
		expect(routeAccessHint("together", access)).toContain("TOGETHER_API_KEY");
	});

	it("a refused key is not callable, though the stale cache still says authenticated", () => {
		expect(providerAccess("together", refused([]))).toMatchObject({ callable: false, uncallableReason: "key-refused" });
	});

	it("one failed list doesn't hide a working key: a timeout leaves it callable, unchecked", () => {
		const timedOut = provider("together", [card("m", "together", 1, { source: "api" })], {
			degradedReason: "The operation was aborted due to timeout",
			degradedSource: "cache",
		});
		expect(providerAccess("together", timedOut)).toEqual({
			callable: true,
			credentialSource: "env",
			keyVerified: false,
		});
	});

	it("a key held, the list failed, the catalog stood in: unreachable, not no-key", () => {
		const fallback = provider("together", [], {
			authenticated: false,
			credentialSource: "none",
			degradedReason: "Together AI API error: 503 Service Unavailable",
			degradedSource: "catalog",
		});
		expect(providerAccess("together", fallback)).toMatchObject({ callable: false, uncallableReason: "unreachable" });
	});

	it("reads a refusal from the status, not from words in the provider's body", () => {
		const reason = (degradedReason: string) =>
			providerAccess("together", provider("together", [], { degradedReason })).uncallableReason;
		expect(reason("Together AI API error: 403 Forbidden")).toBe("key-refused");
		expect(reason("Google API error: 400 Bad Request — API key not valid. Please pass a valid API key.")).toBe(
			"key-refused",
		);
		expect(reason("MINIMAX_API_KEY was refused by every provider that reads it: minimax (API error: 401).")).toBe(
			"key-refused",
		);
		// A 502 whose body says "connection refused" is an outage; the key may be fine.
		expect(reason("Together AI API error: 502 Bad Gateway — upstream connection refused")).toBeUndefined();
	});

	it("a key on a provider that lists publicly is never verified by its list", () => {
		// OpenRouter answers /models without a key, so a junk key passes there.
		const junk = provider("openrouter", [card("m", "openrouter", 1, { source: "api" })]);
		expect(providerAccess("openrouter", junk)).toEqual({ callable: true, credentialSource: "env", keyVerified: false });
	});

	it("a Claude subscription token is not callable: it is never sent on an API call", () => {
		const oauth = provider("anthropic", [], { credentialSource: "oauth" });
		const access = providerAccess("anthropic", oauth);
		expect(access).toMatchObject({ callable: false, uncallableReason: "subscription-oauth" });
		expect(routeAccessHint("anthropic", access)).toContain("ANTHROPIC_API_KEY");
	});

	it("a local runtime needs no key; callable while it answers, not once its list errors", () => {
		const up = provider("ollama", [], { authenticated: false, credentialSource: "none" });
		expect(providerAccess("ollama", up)).toEqual({ callable: true, credentialSource: "none", keyVerified: false });
		// A runtime that isn't running returns an empty list (no routes at all);
		// one that answers with an error is served from cache, marked like this.
		const down = { ...up, unreachableReason: "Ollama API error: 500 Internal Server Error" };
		expect(providerAccess("ollama", down)).toMatchObject({ callable: false, uncallableReason: "unreachable" });
	});
});

describe("cheapestModels and rankedRoutes", () => {
	// 10 cheaper routes on a refused key, then the callable one.
	const reg = () =>
		registry(
			refused(Array.from({ length: 10 }, (_, i) => card(`cheaper-${i}`, "together", 0.01))),
			provider("groq", [card("llama-small", "groq", 0.05)]),
		);

	it("list every route, each marked callable", () => {
		const { matches } = reg().cheapestModels({ limit: 3 });
		expect(matches.map((m) => m.model.id)).toEqual(["cheaper-0", "cheaper-1", "cheaper-2"]);
		expect(matches.every((m) => m.callable === false && m.uncallableReason === "key-refused")).toBe(true);
	});

	it("callableOnly filters before the limit, so cheaper uncallable routes can't push the callable one out", () => {
		const { matches } = reg().cheapestModels({ limit: 3, callableOnly: true });
		expect(matches.map((m) => [m.model.id, m.callable])).toEqual([["llama-small", true]]);
	});

	it("ranked routes carry the same fields and take the same filter", () => {
		const routes = reg().rankedRoutes({ limit: 20 }, "cheapest");
		expect(routes).toHaveLength(11);
		expect(routes.find((r) => r.providerId === "groq")?.callable).toBe(true);
		expect(routes.filter((r) => r.callable === false)).toHaveLength(10);
		expect(reg().rankedRoutes({ callableOnly: true }, "cheapest").map((r) => r.model.id)).toEqual(["llama-small"]);
	});

	it("the v1 discovery plane marks callable too", () => {
		const v1 = reg().cheapestCandidates({ limit: 20 });
		expect(v1.matches.find((m) => m.modelId === "llama-small")?.callable).toBe(true);
		expect(v1.matches.find((m) => m.modelId === "cheaper-0")?.callable).toBe(false);
	});
});

describe("MCP: agents act on row one, so it is a route they can call", () => {
	const reg = () =>
		registry(
			provider("together", [card("cheaper", "together", 0.01)], { authenticated: false, credentialSource: "none" }),
			provider("groq", [card("llama-small", "groq", 0.05)]),
		);

	it("kosha_cheapest_model ranks callable routes, and names the cheaper one a key would add", async () => {
		const data = await mcp(reg(), "kosha_cheapest_model", {});
		expect(data.matches.map((m: { id: string }) => m.id)).toEqual(["llama-small"]);
		expect(data.matches[0]).toMatchObject({ callable: true, credentialSource: "env" });
		expect(data.cheapestOverall).toMatchObject({ id: "cheaper", callable: false, uncallableReason: "no-key" });
		expect(data.cheapestOverall.toCall).toContain("TOGETHER_API_KEY");
	});

	it("no cheapestOverall when the route you can call is just as cheap", async () => {
		const tie = registry(
			provider("together", [card("same", "together", 0.05)], { authenticated: false, credentialSource: "none" }),
			provider("groq", [card("llama-small", "groq", 0.05)]),
		);
		const data = await mcp(tie, "kosha_cheapest_model", {});
		expect(data.matches.map((m: { id: string }) => m.id)).toEqual(["llama-small"]);
		expect(data.cheapestOverall).toBeUndefined();
	});

	it("include_uncallable lists everything, each row saying why not", async () => {
		const data = await mcp(reg(), "kosha_cheapest_model", { include_uncallable: true });
		expect(data.matches.map((m: { id: string; callable: boolean }) => [m.id, m.callable])).toEqual([
			["cheaper", false],
			["llama-small", true],
		]);
		expect(data.cheapestOverall).toBeUndefined();
	});

	it("nothing callable: an empty list and a message, never a silent fallback to the full list", async () => {
		const none = registry(
			provider("together", [card("cheaper", "together", 0.01)], { authenticated: false, credentialSource: "none" }),
		);
		const data = await mcp(none, "kosha_cheapest_model", {});
		expect(data.matches).toEqual([]);
		expect(data.message).toMatch(/No route you can call/);
		expect(data.cheapestOverall.id).toBe("cheaper");
	});

	it("kosha_ranked_routes is callable-only by default too", async () => {
		const data = await mcp(reg(), "kosha_ranked_routes", { strategy: "cheapest" });
		expect(data.routes.map((r: { id: string }) => r.id)).toEqual(["llama-small"]);
		const all = await mcp(reg(), "kosha_ranked_routes", { strategy: "cheapest", include_uncallable: true });
		expect(all.routes).toHaveLength(2);
		expect(all.routes[0]).toMatchObject({ id: "cheaper", callable: false });
	});
});

describe("HTTP /api/models/cheapest", () => {
	it("marks every match and keeps `cheapest` the market's cheapest; ?callable=true asks for yours", async () => {
		delete process.env.KOSHA_PROXY_TOKEN;
		const app = createServer(
			registry(
				provider("together", [card("cheaper", "together", 0.01)], { authenticated: false, credentialSource: "none" }),
				provider("groq", [card("llama-small", "groq", 0.05)]),
			),
		);
		const all = await (await app.request("/api/models/cheapest")).json();
		expect(all.cheapest).toMatchObject({ callable: false });
		expect(all.cheapest.model.id).toBe("cheaper");
		const mine = await (await app.request("/api/models/cheapest?callable=true")).json();
		expect(mine.cheapest.model.id).toBe("llama-small");
		expect(mine.matches.every((m: { callable: boolean }) => m.callable)).toBe(true);
	});
});

describe("proxy: kosha:cheapest tries callable routes first", () => {
	it("a cheaper route on a refused key no longer wins the request", async () => {
		delete process.env.KOSHA_PROXY_TOKEN;
		delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		process.env.GROQ_API_KEY = "groq-test";
		// The refused key is still in the env, and the stub upstream would accept
		// it: before 1.16 the proxy ranked this route first and sent it.
		process.env.TOGETHER_API_KEY = "refused-key";
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const app = createServer(
			registry(
				refused([card("cheaper", "together", 0.01)]),
				{ ...provider("groq", [card("llama-small", "groq", 0.05)]), baseUrl: "https://api.groq.com/openai/v1" },
			),
		);
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "kosha:cheapest", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-model")).toBe("llama-small");
	});
});
