/**
 * Ledger reconciliation: the proxy records the upstream `usage` block as the
 * actual cost next to the pre-flight estimate, for JSON and SSE passthrough.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actualCostFromUsage, type LedgerEntry, ledgerRowUsd, readSpendForMonth, appendLedgerEntry } from "../src/cost.js";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const originalFetch = globalThis.fetch;
const originalGroqKey = process.env.GROQ_API_KEY;
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
	else process.env.GROQ_API_KEY = originalGroqKey;
	vi.restoreAllMocks();
});

const model: ModelCard = {
	id: "llama-cheap",
	name: "llama-cheap",
	provider: "groq",
	mode: "chat",
	capabilities: ["chat"],
	contextWindow: 128_000,
	maxOutputTokens: 8_192,
	aliases: [],
	discoveredAt: Date.now(),
	source: "manual",
	pricing: { inputPerMillion: 1, outputPerMillion: 2 },
};

function app() {
	process.env.GROQ_API_KEY = "g-test";
	const provider: ProviderInfo = {
		id: "groq",
		name: "Groq",
		baseUrl: "https://api.groq.com/openai/v1",
		authenticated: true,
		credentialSource: "env",
		models: [model],
		lastRefreshed: Date.now(),
	};
	return createServer(ModelRegistry.fromJSON({ providers: [provider], aliases: {}, discoveredAt: Date.now() }));
}

/** Rows in this month's default ledger partition tagged with `tenant`. */
async function ledgerRowsFor(tenant: string): Promise<LedgerEntry[]> {
	const d = new Date();
	const file = join(homedir(), ".kosha", `ledger-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
	const raw = await readFile(file, "utf-8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as LedgerEntry)
		.filter((r) => r.tenant === tenant);
}

describe("actualCostFromUsage", () => {
	it("prices OpenAI-shaped usage with cached tokens as a subset of prompt_tokens", () => {
		const out = actualCostFromUsage(
			{ ...model, pricing: { inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 1 } },
			{ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } },
			"openai",
		);
		// 600 uncached × $10 + 100 out × $20 + 400 cached × $1 per MTok
		expect(out?.usd).toBeCloseTo(0.006 + 0.002 + 0.0004, 9);
		expect(out).toMatchObject({ inputTokens: 600, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 0 });
	});

	it("prices Anthropic-shaped usage with cache fields additive to input_tokens, falling back to published ratios", () => {
		const out = actualCostFromUsage(
			{ ...model, pricing: { inputPerMillion: 10, outputPerMillion: 20 } },
			{ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
			"anthropic",
		);
		// 100 × $10 + 10 × $20 + 1000 × $1 (0.1×) + 200 × $12.5 (1.25×)
		expect(out?.usd).toBeCloseTo(0.001 + 0.0002 + 0.001 + 0.0025, 9);
	});

	it("returns null without pricing or without token counts", () => {
		expect(actualCostFromUsage({ ...model, pricing: undefined }, { prompt_tokens: 1 }, "openai")).toBeNull();
		expect(actualCostFromUsage(model, {}, "openai")).toBeNull();
		expect(actualCostFromUsage(model, null, "openai")).toBeNull();
	});
});

describe("ledgerRowUsd / readSpendForMonth prefer the reconciled figure", () => {
	it("uses actualUsd when present and estimatedUsd otherwise", async () => {
		expect(ledgerRowUsd({ estimatedUsd: 5, actualUsd: 2 })).toBe(2);
		expect(ledgerRowUsd({ estimatedUsd: 5 })).toBe(5);
		const now = Date.now();
		const base = { ts: now, provider: "p", modelId: "m", requested: "m", tenant: "prefers-actual", estimatedInputTokens: 0, estimatedOutputTokens: 0, upstreamStatus: 200 };
		await appendLedgerEntry({ ...base, estimatedUsd: 5, actualUsd: 2, usageSource: "upstream" });
		await appendLedgerEntry({ ...base, estimatedUsd: 1 });
		expect(await readSpendForMonth(now, "prefers-actual")).toBeCloseTo(3, 9);
	});
});

describe("proxy ledger reconciliation", () => {
	it("records upstream usage from a JSON passthrough response", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 2000, completion_tokens: 500 } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;
		const res = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer kosha-tenant-json-usage" },
			body: JSON.stringify({ model: "llama-cheap", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 50 }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-usage-source")).toBe("upstream");
		// 2000 × $1 + 500 × $2 per MTok
		expect(Number(res.headers.get("x-kosha-actual-cost-usd"))).toBeCloseTo(0.002 + 0.001, 9);
		// The passthrough body is untouched.
		expect((await res.json()).usage).toEqual({ prompt_tokens: 2000, completion_tokens: 500 });

		await vi.waitFor(async () => {
			const rows = await ledgerRowsFor("json-usage");
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ usageSource: "upstream", actualInputTokens: 2000, actualOutputTokens: 500 });
			expect(rows[0].actualUsd).toBeCloseTo(0.003, 9);
			// max_completion_tokens drives the estimate's expected output.
			expect(rows[0].estimatedOutputTokens).toBe(50);
		});
	});

	it("records usage from the trailing chunk of an SSE passthrough without altering the bytes", async () => {
		const sseBody =
			'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
			'data: {"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":30}}\n\n' +
			"data: [DONE]\n\n";
		globalThis.fetch = vi.fn(
			async () => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const res = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer kosha-tenant-sse-usage" },
			body: JSON.stringify({
				model: "llama-cheap",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
				stream_options: { include_usage: true },
			}),
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(sseBody);

		await vi.waitFor(async () => {
			const rows = await ledgerRowsFor("sse-usage");
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ usageSource: "upstream", actualInputTokens: 300, actualOutputTokens: 30 });
		});
	});

	it("falls back to the estimate when the upstream reports no usage", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "c", choices: [] }), { status: 200, headers: { "content-type": "application/json" } }),
		) as unknown as typeof fetch;
		const res = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer kosha-tenant-no-usage" },
			body: JSON.stringify({ model: "llama-cheap", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-usage-source")).toBe("estimate");
		expect(res.headers.get("x-kosha-actual-cost-usd")).toBeNull();
		await vi.waitFor(async () => {
			const rows = await ledgerRowsFor("no-usage");
			expect(rows).toHaveLength(1);
			expect(rows[0].usageSource).toBe("estimate");
			expect(rows[0]).not.toHaveProperty("actualUsd");
		});
	});
});
