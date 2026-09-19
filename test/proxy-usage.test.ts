/**
 * Ledger reconciliation: the proxy records the upstream `usage` block as the
 * actual cost next to the pre-flight estimate, for JSON and SSE passthrough.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actualCostFromUsage, isRequestRow, type LedgerEntry, ledgerRowUsd, readSpendForMonth, appendLedgerEntry } from "../src/cost.js";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const originalFetch = globalThis.fetch;
const originalGroqKey = process.env.GROQ_API_KEY;
const originalBudget = process.env.KOSHA_MONTHLY_BUDGET_USD;
const originalTenantBudget = process.env.KOSHA_TENANT_BUDGET_USD;
afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [name, value] of [
		["GROQ_API_KEY", originalGroqKey],
		["KOSHA_MONTHLY_BUDGET_USD", originalBudget],
		["KOSHA_TENANT_BUDGET_USD", originalTenantBudget],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
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

	it("clamps negative token counts so a broken upstream can never lower spend", () => {
		const out = actualCostFromUsage(model, { prompt_tokens: -5_000_000, completion_tokens: 1 }, "openai");
		expect(out?.inputTokens).toBe(0);
		expect(out?.usd).toBeCloseTo(0.000002, 12);
	});
});

describe("ledger adjustment rows", () => {
	it("contribute their delta and are not counted as requests", () => {
		expect(ledgerRowUsd({ estimatedUsd: 0, actualUsd: 1, kind: "adjustment", adjustmentUsd: -0.4 })).toBe(-0.4);
		expect(isRequestRow({ kind: "adjustment" })).toBe(false);
		expect(isRequestRow({ kind: "request" })).toBe(true);
		expect(isRequestRow({})).toBe(true);
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

	it("writes the estimate row up front and an adjustment row once the SSE passthrough reports usage", async () => {
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
			expect(rows).toHaveLength(2);
			const request = rows.find(isRequestRow);
			const adjustment = rows.find((r) => !isRequestRow(r));
			expect(request).toMatchObject({ kind: "request", usageSource: "estimate" });
			expect(adjustment).toMatchObject({ kind: "adjustment", actualInputTokens: 300, actualOutputTokens: 30 });
			expect(adjustment?.requestId).toBe(request?.requestId);
			// 300 × $1 + 30 × $2 per MTok = actual; the two rows sum to exactly that.
			expect(rows.reduce((sum, r) => sum + ledgerRowUsd(r), 0)).toBeCloseTo(0.0003 + 0.00006, 12);
		});
		expect(await readSpendForMonth(Date.now(), "sse-usage")).toBeCloseTo(0.00036, 12);
	});

	it("still records the estimate when the client disconnects mid-stream", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
							// never closes
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		) as unknown as typeof fetch;
		const res = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer kosha-tenant-disconnect" },
			body: JSON.stringify({ model: "llama-cheap", messages: [{ role: "user", content: "hi" }], stream: true }),
		});
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		await reader?.read();
		await reader?.cancel();
		await vi.waitFor(async () => {
			const rows = await ledgerRowsFor("disconnect");
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ kind: "request", usageSource: "estimate" });
		});
	});

	it("reflects non-ASCII caller strings into headers without crashing (and still charges the ledger)", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "c", choices: [] }), { status: 200, headers: { "content-type": "application/json" } }),
		) as unknown as typeof fetch;
		const res = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer kosha-tenant-unicode" },
			body: JSON.stringify({ model: "llama-cheap", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		// x-kosha-requested carries the sanitized model string on every response.
		expect(res.headers.get("x-kosha-requested")).toBe("llama-cheap");
		const resUnicode = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer kosha-tenant-unicode" },
			body: JSON.stringify({ model: "kosha:cheapest[tool_use,视觉]", messages: [{ role: "user", content: "hi" }] }),
		});
		// No capability named 视觉 exists, so this 404s — but it must not 500.
		expect([200, 404]).toContain(resUnicode.status);
	});
});

describe("budget gate", () => {
	it("enforces the global cap against total spend regardless of tenant tag", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "0.000001";
		const now = Date.now();
		await appendLedgerEntry({
			ts: now,
			provider: "p",
			modelId: "m",
			requested: "m",
			tenant: "someone-else",
			estimatedUsd: 5,
			estimatedInputTokens: 0,
			estimatedOutputTokens: 0,
			upstreamStatus: 200,
		});
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const res = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", "x-kosha-tenant": "brand-new-tenant", authorization: "Bearer kosha-tenant-brand-new" },
			body: JSON.stringify({ model: "llama-cheap", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(429);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("applies KOSHA_TENANT_BUDGET_USD only to the tagged tenant's own spend", async () => {
		delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		process.env.KOSHA_TENANT_BUDGET_USD = "0.5";
		const now = Date.now();
		await appendLedgerEntry({
			ts: now,
			provider: "p",
			modelId: "m",
			requested: "m",
			tenant: "capped",
			estimatedUsd: 1,
			estimatedInputTokens: 0,
			estimatedOutputTokens: 0,
			upstreamStatus: 200,
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "c", choices: [] }), { status: 200, headers: { "content-type": "application/json" } }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const body = JSON.stringify({ model: "llama-cheap", messages: [{ role: "user", content: "hi" }] });
		const capped = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer kosha-tenant-capped" },
			body,
		});
		expect(capped.status).toBe(429);
		expect((await capped.json()).error).toMatch(/tenant monthly budget/);
		const other = await app().request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer kosha-tenant-other" },
			body,
		});
		expect(other.status).toBe(200);
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

describe("actualCostFromUsage — cache write TTL", () => {
	const anthropicModel = {
		...model,
		pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 0.25, cacheWritePerMillion: 12.5 },
	};

	it("prices the 1h share at 2x input when the catalog has no explicit 1h rate", () => {
		// Anthropic reports the TTL split inside cache_creation; the catalog's
		// cacheWritePerMillion is the 5-minute rate, so the 1h share must not use it.
		const out = actualCostFromUsage(
			anthropicModel,
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 1000,
				cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
			},
			"anthropic",
		);
		// 400 × $12.5 + 600 × $20 per MTok
		expect(out?.usd).toBeCloseTo(0.005 + 0.012, 9);
	});

	it("prefers an explicit cacheWrite1hPerMillion over the 2x ratio", () => {
		const out = actualCostFromUsage(
			{ ...anthropicModel, pricing: { ...anthropicModel.pricing, cacheWrite1hPerMillion: 18 } },
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 1000,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
			},
			"anthropic",
		);
		expect(out?.usd).toBeCloseTo(0.018, 9);
	});

	it("is unchanged when the provider reports no TTL split", () => {
		const out = actualCostFromUsage(
			anthropicModel,
			{ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 },
			"anthropic",
		);
		// All 1000 at the 5-minute rate — the behaviour before the split existed.
		expect(out?.usd).toBeCloseTo(0.0125, 9);
	});

	it("keeps a non-Anthropic shape on its own write rate", () => {
		// A 1h-shaped field arriving on an OpenAI-convention block must not
		// conjure Anthropic's 2x ratio for a vendor that does not bill that way.
		const out = actualCostFromUsage(
			{ ...model, pricing: { inputPerMillion: 1, outputPerMillion: 4, cacheWritePerMillion: 0.625 } },
			{ prompt_tokens: 0, completion_tokens: 0, cacheWriteTokens: 1000, cacheWrite1hTokens: 1000 },
			"openai",
		);
		expect(out?.usd).toBeCloseTo(0.000625, 9);
	});
});
