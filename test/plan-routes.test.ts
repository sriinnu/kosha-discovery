/**
 * Subscription-plan models in routing: their own group in `cheapest` (never
 * ranked as free), a pass through the proxy's budget gate at $0, and the
 * Anthropic wire picked from the provider descriptor.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stands in for a plan descriptor that speaks the Anthropic wire. It rides on
// groq so the host is already in the proxy's catalog allowlist.
const wireOverride = vi.hoisted(() => ({ on: false }));
vi.mock("../src/provider-catalog.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/provider-catalog.js")>();
	return {
		...actual,
		getProviderDescriptor: (id: string) => {
			const descriptor = actual.getProviderDescriptor(id);
			if (!wireOverride.on || id !== "groq" || !descriptor) return descriptor;
			return { ...descriptor, wire: "anthropic" as const, anthropicMessagesPath: "/anthropic/v1/messages" };
		},
	};
});

import { cmdCheapest } from "../src/cli-cmd-query.js";
import { handleJsonRpc, type McpDeps } from "../src/mcp-server.js";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const saved = {
	KOSHA_LEDGER_PATH: process.env.KOSHA_LEDGER_PATH,
	KOSHA_PROXY_TOKEN: process.env.KOSHA_PROXY_TOKEN,
	KOSHA_MONTHLY_BUDGET_USD: process.env.KOSHA_MONTHLY_BUDGET_USD,
	KOSHA_TENANT_BUDGET_USD: process.env.KOSHA_TENANT_BUDGET_USD,
	GROQ_API_KEY: process.env.GROQ_API_KEY,
	DEEPINFRA_API_KEY: process.env.DEEPINFRA_API_KEY,
};
const originalFetch = globalThis.fetch;

let ledgerDir = "";
beforeEach(async () => {
	// Never the real ~/.kosha ledger.
	ledgerDir = await mkdtemp(join(tmpdir(), "kosha-plan-ledger-"));
	process.env.KOSHA_LEDGER_PATH = join(ledgerDir, "ledger.jsonl");
	delete process.env.KOSHA_PROXY_TOKEN;
	delete process.env.KOSHA_MONTHLY_BUDGET_USD;
	delete process.env.KOSHA_TENANT_BUDGET_USD;
	process.env.GROQ_API_KEY = "g-test";
	process.env.DEEPINFRA_API_KEY = "d-test";
});

afterEach(async () => {
	wireOverride.on = false;
	await rm(ledgerDir, { recursive: true, force: true });
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

function card(id: string, provider: string, extra: Partial<ModelCard> = {}): ModelCard {
	return {
		id,
		name: id,
		provider,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		...extra,
	};
}

/** A plan's model: no price, tagged the way the plan adapters tag it. */
function planCard(id: string, provider: string, extra: Partial<ModelCard> = {}): ModelCard {
	return card(id, provider, { rawCapabilities: ["subscription_plan"], ...extra });
}

function provider(id: string, models: ModelCard[]): ProviderInfo {
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

function registryOf(...providers: ProviderInfo[]): ModelRegistry {
	return ModelRegistry.fromJSON({ providers, aliases: {}, discoveredAt: Date.now() });
}

/** groq holds the plan models here; deepinfra is the pay-per-token route. */
function mixedRegistry(): ModelRegistry {
	return registryOf(
		provider("groq", [
			planCard("plan-coder", "groq"),
			planCard("plan-long", "groq", { contextWindow: 1_000_000 }),
			planCard("plan-embed", "groq", { mode: "embedding", capabilities: ["embedding"] }),
		]),
		provider("deepinfra", [
			card("llama-paid", "deepinfra", { pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
			card("llama-unknown", "deepinfra"),
		]),
	);
}

/**
 * `cmdCheapest` calls `registry.discover()` before it queries, which would
 * replace the fixture with a live scan. Pin it, and fail on any network call.
 */
function offline(registry: ModelRegistry): ModelRegistry {
	vi.spyOn(registry, "discover").mockResolvedValue([]);
	globalThis.fetch = vi.fn(async () => {
		throw new Error("network call in an offline test");
	}) as unknown as typeof fetch;
	return registry;
}

function mockUpstream(body: unknown = { id: "chatcmpl-test", choices: [] }) {
	const fetchMock = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function chat(app: ReturnType<typeof createServer>, model: string) {
	return app.request("/proxy/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
	});
}

describe("cheapest: plan-billed models", () => {
	it("lists them under includedInPlans, never in the price ranking", () => {
		const result = mixedRegistry().cheapestModels({ mode: "chat", includeUnpriced: true, limit: 10 });

		expect(result.matches.map((m) => m.model.id)).toEqual(["llama-paid", "llama-unknown"]);
		expect(result.matches.some((m) => m.score === 0)).toBe(false);
		expect(result.includedInPlans.map((m) => m.id)).toEqual(["plan-coder", "plan-long"]);
		expect(result.pricedCandidates).toBe(1);
		// Only llama-unknown lacks a price; a plan model isn't "skipped".
		expect(result.skippedNoPricing).toBe(1);
	});

	it("applies the query's filters and limit to the plan group too", () => {
		const registry = mixedRegistry();
		expect(
			registry.cheapestModels({ mode: "chat", minContextWindow: 500_000 }).includedInPlans.map((m) => m.id),
		).toEqual(["plan-long"]);
		expect(registry.cheapestModels({ mode: "embedding" }).includedInPlans.map((m) => m.id)).toEqual(["plan-embed"]);
		expect(registry.cheapestModels({ mode: "chat", provider: "deepinfra" }).includedInPlans).toEqual([]);
		expect(registry.cheapestModels({ mode: "chat", limit: 1 }).includedInPlans).toHaveLength(1);
	});

	it("keeps them out of the ranking even when a catalog gave one a $0 price", () => {
		const registry = registryOf(
			provider("groq", [planCard("plan-zero", "groq", { pricing: { inputPerMillion: 0, outputPerMillion: 0 } })]),
			provider("deepinfra", [
				card("llama-paid", "deepinfra", { pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
			]),
		);
		const result = registry.cheapestModels({ mode: "chat", includeUnpriced: true });
		expect(result.matches.map((m) => m.model.id)).toEqual(["llama-paid"]);
		expect(result.includedInPlans.map((m) => m.id)).toEqual(["plan-zero"]);
	});

	it("still offers them as routes, after the priced ones and without a price", () => {
		const routes = mixedRegistry().rankedRoutes({ mode: "chat", limit: 10 }, "cheapest");
		expect(routes[0].model.id).toBe("llama-paid");
		const plan = routes.find((r) => r.model.id === "plan-coder");
		expect(plan).toBeDefined();
		expect(plan?.price).toBeNull();
	});

	it("MCP kosha_cheapest_model returns them in includedInPlans beside matches", async () => {
		const registry = mixedRegistry();
		const deps: McpDeps = { registry: async () => registry };
		const res = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kosha_cheapest_model", arguments: {} } },
			deps,
		);
		if (!res?.result) throw new Error(`expected a result, got ${JSON.stringify(res)}`);
		const data = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);

		expect(data.matches.map((m: { id: string }) => m.id)).toEqual(["llama-paid"]);
		expect(data.missingCredentials).toEqual(expect.any(Array));
		expect(data.includedInPlans).toEqual([
			{ id: "plan-coder", provider: "groq", name: "plan-coder", contextWindow: 128_000 },
			{ id: "plan-long", provider: "groq", name: "plan-long", contextWindow: 1_000_000 },
		]);
	});

	it("CLI prints an 'Included in your plans' group and carries it in --json", async () => {
		const registry = offline(mixedRegistry());
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});

		await cmdCheapest(registry, { mode: "chat" });
		const text = lines.join("\n");
		expect(text).toContain("Included in your plans");
		const [ranking, plans] = text.split("Included in your plans");
		expect(ranking).toContain("llama-paid");
		expect(ranking).not.toContain("plan-coder");
		expect(plans).toContain("plan-coder");
		expect(plans).toContain("plan-long");

		lines.length = 0;
		await cmdCheapest(registry, { mode: "chat", json: true });
		const json = JSON.parse(lines.join("\n"));
		expect(json.matches.map((m: { model: { id: string } }) => m.model.id)).toEqual(["llama-paid"]);
		expect(json.includedInPlans.map((m: { id: string }) => m.id)).toEqual(["plan-coder", "plan-long"]);
	});

	it("CLI shows the plan group when nothing else is priced", async () => {
		const registry = offline(registryOf(provider("groq", [planCard("plan-coder", "groq")])));
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		await cmdCheapest(registry, { mode: "chat" });
		const text = lines.join("\n");
		expect(text).toContain("Included in your plans");
		expect(text).toContain("plan-coder");
	});
});

describe("proxy budget gate: plan-billed models", () => {
	it("forwards a plan model under a budget and writes no ledger row", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1";
		const app = createServer(registryOf(provider("groq", [planCard("plan-coder", "groq")])));
		const fetchMock = mockUpstream({
			id: "x",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});

		const res = await chat(app, "plan-coder");

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(res.headers.get("x-kosha-attempt-chain")).not.toContain("unpriced");
		expect(res.headers.get("x-kosha-estimated-cost-usd")).toBeNull();
		// The plan is already paid: nothing is charged, so nothing is recorded.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await readdir(ledgerDir)).toEqual([]);
	});

	it("tries a plan route before a priced one for the same named model", async () => {
		// The plan is already paid for this model, so pay-as-you-go is the fallback.
		const app = createServer(
			registryOf(
				provider("deepinfra", [
					card("shared-coder", "deepinfra", { pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
				]),
				provider("groq", [planCard("shared-coder", "groq")]),
			),
		);
		const fetchMock = mockUpstream();

		const res = await chat(app, "shared-coder");

		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-provider")).toBe("groq");
		expect(String(fetchMock.mock.calls[0][0])).toContain("groq");
	});

	it("passes a tenant budget too", async () => {
		process.env.KOSHA_TENANT_BUDGET_USD = "0.5";
		const app = createServer(registryOf(provider("groq", [planCard("plan-coder", "groq")])));
		mockUpstream();
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", "x-kosha-tenant": "team-a" },
			body: JSON.stringify({ model: "plan-coder", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
	});

	it("still refuses an unpriced or catalog-$0 model that no plan pays for", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1";
		const app = createServer(
			registryOf(
				provider("groq", [
					card("no-price", "groq"),
					card("zero-price", "groq", { pricing: { inputPerMillion: 0, outputPerMillion: 0 } }),
				]),
			),
		);
		const fetchMock = mockUpstream();

		for (const id of ["no-price", "zero-price"]) {
			const res = await chat(app, id);
			expect(res.status).toBe(422);
			expect(((await res.json()) as { attemptChain: string[] }).attemptChain).toContain("groq:unpriced");
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("proxy: Anthropic wire from the descriptor", () => {
	const anthropicReply = {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "plan-coder",
		content: [{ type: "text", text: "hello" }],
		stop_reason: "end_turn",
		usage: { input_tokens: 3, output_tokens: 2 },
	};

	it("sends a wire:'anthropic' provider to its messages path with x-api-key", async () => {
		wireOverride.on = true;
		const app = createServer(registryOf(provider("groq", [planCard("plan-coder", "groq")])));
		const fetchMock = mockUpstream(anthropicReply);

		const res = await chat(app, "plan-coder");

		expect(res.status).toBe(200);
		const [url, init] = fetchMock.mock.calls[0];
		const sent = new URL(String(url));
		// Same catalog host; only the path is the descriptor's.
		expect(sent.origin).toBe("https://api.groq.com");
		expect(sent.pathname).toBe("/anthropic/v1/messages");
		const headers = new Headers(init?.headers);
		expect(headers.get("x-api-key")).toBe("g-test");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(headers.get("authorization")).toBeNull();
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("plan-coder");
		expect(body.max_tokens).toEqual(expect.any(Number));
		// The Messages reply comes back in the OpenAI shape.
		const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
		expect(json.choices[0].message.content).toBe("hello");
	});

	it("leaves a provider without the wire field on chat-completions", async () => {
		const app = createServer(registryOf(provider("groq", [planCard("plan-coder", "groq")])));
		const fetchMock = mockUpstream();

		const res = await chat(app, "plan-coder");

		expect(res.status).toBe(200);
		const [url, init] = fetchMock.mock.calls[0];
		expect(new URL(String(url)).pathname).toMatch(/\/chat\/completions$/);
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer g-test");
	});
});
