/**
 * Ranking on a catalog shaped like the real one: dozens of catalog-only $0
 * routes sit in front of every priced model. In 1.10.0 each surface cut the
 * list to its limit first and filtered second, so the cut held nothing but
 * $0 routes: `kosha:cheapest` under a budget refused every request, and
 * `min_context_k` found nothing. These fixtures have more $0 routes than any
 * limit the code uses, so filtering after the cut can't pass them.
 */

import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleJsonRpc, type McpDeps } from "../src/mcp-server.js";
import { isUnverifiedZeroPrice } from "../src/price-trust.js";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const saved = {
	KOSHA_LEDGER_PATH: process.env.KOSHA_LEDGER_PATH,
	KOSHA_PROXY_TOKEN: process.env.KOSHA_PROXY_TOKEN,
	KOSHA_MONTHLY_BUDGET_USD: process.env.KOSHA_MONTHLY_BUDGET_USD,
	GROQ_API_KEY: process.env.GROQ_API_KEY,
};
const originalFetch = globalThis.fetch;

let ledgerDir = "";
beforeEach(async () => {
	// Never the real ~/.kosha ledger.
	ledgerDir = await mkdtemp(join(tmpdir(), "kosha-ledger-"));
	process.env.KOSHA_LEDGER_PATH = join(ledgerDir, "ledger.jsonl");
});

afterEach(async () => {
	await chmod(ledgerDir, 0o700).catch(() => {});
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
		contextWindow: 32_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		...extra,
	};
}

const zero = { inputPerMillion: 0, outputPerMillion: 0 };

/** 30 catalog-$0 groq routes, then the real ones. */
function catalog(): ModelCard[] {
	return [
		...Array.from({ length: 30 }, (_, i) =>
			card(`free-lunch-${String(i).padStart(2, "0")}`, "groq", { pricing: zero }),
		),
		card("llama-small", "groq", { pricing: { inputPerMillion: 0.05, outputPerMillion: 0.1 } }),
		card("llama-long", "groq", { contextWindow: 500_000, pricing: { inputPerMillion: 0.6, outputPerMillion: 0.9 } }),
	];
}

function provider(id: string, models: ModelCard[], authenticated = true): ProviderInfo {
	return { id, name: id, baseUrl: "", authenticated, credentialSource: "env", models, lastRefreshed: Date.now() };
}

function registry(models = catalog(), ...others: ProviderInfo[]): ModelRegistry {
	const groq = { ...provider("groq", models), baseUrl: "https://api.groq.com/openai/v1" };
	return ModelRegistry.fromJSON({ providers: [groq, ...others], aliases: {}, discoveredAt: Date.now() });
}

async function mcp(reg: ModelRegistry, name: string, args: Record<string, unknown>) {
	const deps: McpDeps = { registry: async () => reg };
	const res = await handleJsonRpc(
		{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
		deps,
	);
	if (!res?.result) throw new Error(`no result from ${name}: ${JSON.stringify(res?.error)}`);
	const text = (res.result as { content: Array<{ text: string }> }).content[0].text;
	return JSON.parse(text);
}

function proxyApp() {
	delete process.env.KOSHA_PROXY_TOKEN;
	process.env.GROQ_API_KEY = "groq-test";
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
	return createServer(registry());
}

function chat(app: ReturnType<typeof createServer>, model: string) {
	return app.request("/proxy/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
	});
}

describe("the shared ranking", () => {
	it("ranks priced models first and marks catalog $0 as unverified, not cheapest", () => {
		const reg = registry();
		expect(reg.cheapestModels({ mode: "chat", limit: 2 }).matches.map((m) => m.model.id)).toEqual([
			"llama-small",
			"llama-long",
		]);
		const withUnpriced = reg.cheapestModels({ mode: "chat", limit: 3, includeUnpriced: true }).matches;
		expect(withUnpriced[2]).toMatchObject({ priceUnverified: true, score: undefined });
	});

	it("applies minContextWindow before the limit", () => {
		const matches = registry().cheapestModels({ mode: "chat", minContextWindow: 400_000, limit: 1 }).matches;
		expect(matches.map((m) => m.model.id)).toEqual(["llama-long"]);
	});

	it("doesn't let a cache rate beside $0 input pass as a real price", () => {
		// Seen live: gemini-exp-1206 at $0 in / $0 out / $0.03 cache read.
		const reg = registry([
			card("llama-small", "groq", { pricing: { inputPerMillion: 0.05, outputPerMillion: 0.1 } }),
			card("gemini-exp", "groq", { pricing: { ...zero, cacheReadPerMillion: 0.03 } }),
		]);
		expect(reg.cheapestModels({ mode: "chat", limit: 1 }).matches[0].model.id).toBe("llama-small");
	});

	it("still treats local runtimes and OpenRouter :free as real $0", () => {
		const reg = registry([
			card("llama-small", "groq", { pricing: { inputPerMillion: 0.05, outputPerMillion: 0.1 } }),
			card("qwen3:8b", "ollama", { pricing: zero }),
		]);
		expect(reg.cheapestModels({ mode: "chat", limit: 1 }).matches[0].model.id).toBe("qwen3:8b");
		expect(isUnverifiedZeroPrice(card("meta/llama:free", "openrouter", { pricing: zero }))).toBe(false);
		expect(isUnverifiedZeroPrice(card("meta/llama", "openrouter", { pricing: zero }))).toBe(true);
	});

	it("scores a speech model by its per-second rate, not its $0 tokens", () => {
		const stt = card("whisper", "groq", {
			mode: "audio",
			capabilities: ["speech_to_text"],
			pricing: { ...zero, audioInputPerSecond: 0.006 },
		});
		const match = registry([stt]).cheapestModels({ mode: "audio", role: "speech_to_text", limit: 1 }).matches[0];
		expect(match).toMatchObject({ score: 0.006 });
	});

	it("ranks by the strategy before the limit, and keeps catalog $0 behind priced routes", () => {
		const reg = registry(
			[card("slow-cheap", "groq", { pricing: { inputPerMillion: 1, outputPerMillion: 1 } })],
			provider("openrouter", [
				card("fast-dear", "openrouter", { pricing: { inputPerMillion: 5, outputPerMillion: 5 } }),
			]),
			provider("fireworks", [card("fastest-free-lunch", "fireworks", { pricing: zero })]),
		);
		for (let i = 0; i < 5; i++) {
			reg.recordProxyOutcome("groq", { ok: true, latencyMs: 2_000 });
			reg.recordProxyOutcome("openrouter", { ok: true, latencyMs: 100 });
			reg.recordProxyOutcome("fireworks", { ok: true, latencyMs: 10 });
		}
		expect(reg.rankedRoutes({ mode: "chat", limit: 1 }, "fastest")[0].model.id).toBe("fast-dear");
	});
});

describe("kosha: selectors in the proxy", () => {
	it("routes kosha:cheapest to the cheapest priced model under a budget", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1000";
		const res = await chat(proxyApp(), "kosha:cheapest");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-model")).toBe("llama-small");
	});

	it("routes kosha:cheapest to a priced model with no budget too", async () => {
		delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		const res = await chat(proxyApp(), "kosha:cheapest");
		expect(res.headers.get("x-kosha-model")).toBe("llama-small");
	});

	it("finds the long-context model for kosha:cheapest[400k]", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1000";
		const res = await chat(proxyApp(), "kosha:cheapest[400k]");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-model")).toBe("llama-long");
	});
});

describe("MCP tools", () => {
	it("kosha_cheapest_model honours min_context_k past the cheapest few", async () => {
		const data = await mcp(registry(), "kosha_cheapest_model", { min_context_k: 400 });
		expect(data.matches.map((m: { id: string }) => m.id)).toEqual(["llama-long"]);
	});

	it("kosha_ranked_routes puts priced routes first and flags unverified $0", async () => {
		const data = await mcp(registry(), "kosha_ranked_routes", { strategy: "cheapest", limit: 3 });
		expect(data.routes.map((r: { id: string }) => r.id).slice(0, 2)).toEqual(["llama-small", "llama-long"]);
		expect(data.routes[2]).toMatchObject({ priceUnverified: true, price: null });
	});

	it("kosha_context_strategy offers an alternative that fits the conversation", async () => {
		const reg = registry([
			...catalog(),
			card("big-now", "groq", { contextWindow: 128_000, pricing: { inputPerMillion: 5, outputPerMillion: 15 } }),
		]);
		const data = await mcp(reg, "kosha_context_strategy", { model: "big-now", current_tokens: 100_000 });
		const sw = data.options.find((o: { strategy: string }) => o.strategy === "switch_model");
		expect(sw.viable).toBe(true);
		expect(JSON.stringify(sw)).toContain("llama-long");
	});
});

// chmod doesn't bind root, so the write wouldn't fail there.
describe.skipIf(process.getuid?.() === 0)("a ledger that can't be written", () => {
	it("refuses budgeted requests until the lost row lands, then counts it", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1000";
		const app = proxyApp();
		expect((await chat(app, "llama-small")).status).toBe(200);
		// A read-only partition in a writable directory: a probe file beside
		// it would still say "writable".
		const partition = await vi.waitFor(async () => {
			const [name] = await readdir(ledgerDir);
			expect(name).toBeDefined();
			return name;
		});
		const partitionPath = join(ledgerDir, partition);
		await chmod(partitionPath, 0o400);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await chat(app, "llama-small")).status).toBe(200); // the write fails after the response
		await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("kosha: ledger write failed:", expect.any(String)));
		const refused = await chat(app, "llama-small");
		expect(refused.status).toBe(503);
		expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/could not be written/) });
		await chmod(partitionPath, 0o600);
		expect((await chat(app, "llama-small")).status).toBe(200);
		await vi.waitFor(async () => {
			const rows = (await readFile(partitionPath, "utf-8")).trim().split("\n");
			expect(rows).toHaveLength(3);
		});
	});
});

describe("concurrent requests under one budget", () => {
	it("don't all pass against the same committed spend", async () => {
		// Each ~$0.06; the cap fits one.
		process.env.KOSHA_MONTHLY_BUDGET_USD = "0.1";
		const app = proxyApp();
		const upstream = globalThis.fetch;
		globalThis.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return upstream(...args);
		}) as unknown as typeof fetch;
		const body = JSON.stringify({ model: "llama-long", messages: [{ role: "user", content: "x".repeat(350_000) }] });
		const send = () =>
			app.request("/proxy/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
		const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort();
		expect(statuses).toEqual([200, 429]);
	});
});

describe("kosha: selectors with routes we can't call", () => {
	it("still reach a callable route behind 20 cheaper ones without credentials", async () => {
		delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		delete process.env.TOGETHER_API_KEY;
		proxyApp(); // credentials and a stub upstream
		const together = provider(
			"together",
			Array.from({ length: 25 }, (_, i) =>
				card(`cheaper-${i}`, "together", { pricing: { inputPerMillion: 0.01, outputPerMillion: 0.01 } }),
			),
			false,
		);
		const res = await createServer(registry(catalog(), together)).request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "kosha:cheapest", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-model")).toBe("llama-small");
	});
});

describe("a request that would cross the budget", () => {
	const longPrompt = JSON.stringify({
		model: "llama-long",
		messages: [{ role: "user", content: "x".repeat(350_000) }],
	});

	it("is refused with 429 even though spend is still under the cap", async () => {
		// ~100k input tokens at $0.60/M ≈ $0.06, against a $0.01 budget with $0 spent.
		process.env.KOSHA_MONTHLY_BUDGET_USD = "0.01";
		const res = await proxyApp().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: longPrompt,
		});
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ error: "this request would exceed the monthly budget" });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("lets the same request through when the budget covers it", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1";
		const res = await proxyApp().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: longPrompt,
		});
		expect(res.status).toBe(200);
	});
});

describe("catalog $0 with a rate in another unit", () => {
	// A chat model is billed by tokens; an image-input rate doesn't make $0
	// tokens a real price, and the proxy would record its spend as $0.
	const vision = card("vision-free-lunch", "groq", { pricing: { ...zero, imageInputPerImage: 0.000001 } });

	it("stays unverified in the ranking", () => {
		const reg = registry([
			card("llama-small", "groq", { pricing: { inputPerMillion: 0.05, outputPerMillion: 0.1 } }),
			vision,
		]);
		expect(reg.cheapestModels({ mode: "chat", limit: 1 }).matches[0].model.id).toBe("llama-small");
	});

	it("is refused under a budget", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1000";
		delete process.env.KOSHA_PROXY_TOKEN;
		process.env.GROQ_API_KEY = "groq-test";
		globalThis.fetch = vi.fn() as unknown as typeof fetch;
		const res = await createServer(registry([vision])).request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "vision-free-lunch", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(422);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("still counts as a price for an image model", () => {
		const imageModel = card("img", "groq", { mode: "image", pricing: { ...zero, imageOutputPerImage: 0.04 } });
		expect(registry([imageModel]).cheapestModels({ mode: "image", limit: 1 }).matches[0]).toMatchObject({
			score: 0.04,
		});
	});
});

describe("over-budget 429 with a tenant cap", () => {
	it("reports the tenant's spend and cap, not the global ones", async () => {
		delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		process.env.KOSHA_TENANT_BUDGET_USD = "0.01";
		const res = await proxyApp().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", "x-kosha-tenant": "team-a" },
			body: JSON.stringify({ model: "llama-long", messages: [{ role: "user", content: "x".repeat(350_000) }] }),
		});
		delete process.env.KOSHA_TENANT_BUDGET_USD;
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ tenant: "team-a", spentUsd: 0, budgetUsd: 0.01 });
		expect(res.headers.get("x-kosha-budget-usd")).toBe("0.01");
	});
});
