/**
 * Cost primitives (estimate + ledger + budget gate) and proxy wiring.
 */

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendLedgerEntry,
	estimateRequestCost,
	readMonthlyBudgetUsd,
	readSpendForMonth,
} from "../src/cost.js";
import type { ModelCard } from "../src/types.js";

function model(pricing?: { input: number; output: number }): ModelCard {
	return {
		id: "gpt-4o-mini",
		name: "gpt-4o-mini",
		provider: "openai",
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: 0,
		source: "manual",
		pricing: pricing ? { inputPerMillion: pricing.input, outputPerMillion: pricing.output } : undefined,
	};
}

describe("estimateRequestCost", () => {
	it("returns null when the model has no pricing", () => {
		expect(estimateRequestCost(model(), { messages: [] })).toBeNull();
	});

	it("estimates a chat request using a chars/token approximation", () => {
		const m = model({ input: 10, output: 30 });
		const est = estimateRequestCost(m, {
			messages: [{ role: "user", content: "x".repeat(350) }],
			max_tokens: 200,
		});
		expect(est).not.toBeNull();
		expect(est?.expectedOutputTokens).toBe(200);
		// 350 chars / 3.5 = 100 input tokens (ceil).
		expect(est?.inputTokens).toBe(100);
		// 100/1M*10 + 200/1M*30 = 0.001 + 0.006 = 0.007
		expect(est?.estimatedUsd).toBeCloseTo(0.007, 6);
	});

	it("falls back to a default expected-output when max_tokens is missing", () => {
		const m = model({ input: 1, output: 2 });
		const est = estimateRequestCost(m, { messages: [{ role: "user", content: "hi" }] });
		expect(est?.expectedOutputTokens).toBe(512);
	});
});

describe("ledger", () => {
	let dir: string;
	let path: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "kosha-ledger-"));
		path = join(dir, "ledger.jsonl");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates the ledger on first append and reads back the row", async () => {
		await appendLedgerEntry(
			{
				ts: Date.now(),
				provider: "openai",
				modelId: "gpt-4o-mini",
				requested: "gpt-4o-mini",
				tenant: null,
				estimatedUsd: 0.05,
				estimatedInputTokens: 100,
				estimatedOutputTokens: 200,
				upstreamStatus: 200,
			},
			path,
		);
		const raw = await readFile(path, "utf-8");
		const row = JSON.parse(raw.trim());
		expect(row.modelId).toBe("gpt-4o-mini");
		expect(row.estimatedUsd).toBeCloseTo(0.05);
	});

	it("sums spend within the current calendar month, ignoring rows outside it", async () => {
		const now = Date.now();
		const lastMonth = new Date(new Date(now).setMonth(new Date(now).getMonth() - 2)).getTime();
		await appendLedgerEntry(makeEntry(now, "tenant-a", 0.5), path);
		await appendLedgerEntry(makeEntry(now, "tenant-a", 1.0), path);
		await appendLedgerEntry(makeEntry(lastMonth, "tenant-a", 99), path);
		await appendLedgerEntry(makeEntry(now, "tenant-b", 5), path);

		expect(await readSpendForMonth(now, "tenant-a", path)).toBeCloseTo(1.5);
		// Without a tenant filter we sum across all tenants.
		expect(await readSpendForMonth(now, null, path)).toBeCloseTo(6.5);
	});

	it("treats a missing ledger as $0 spent (no error)", async () => {
		expect(await readSpendForMonth(Date.now(), null, join(dir, "absent.jsonl"))).toBe(0);
	});

	it("survives a corrupt line without crashing the rollup", async () => {
		await writeFile(path, '{"not":"valid"\nBLOB\n', "utf-8"); // truncated JSON + garbage line
		expect(await readSpendForMonth(Date.now(), null, path)).toBe(0);
	});
});

describe("readMonthlyBudgetUsd", () => {
	const original = process.env.KOSHA_MONTHLY_BUDGET_USD;
	afterEach(() => {
		if (original === undefined) delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		else process.env.KOSHA_MONTHLY_BUDGET_USD = original;
	});

	it("returns null when unset", () => {
		delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		expect(readMonthlyBudgetUsd()).toBeNull();
	});
	it("parses a positive float", () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "12.5";
		expect(readMonthlyBudgetUsd()).toBe(12.5);
	});
	it("returns null for a non-positive or NaN value", () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "-3";
		expect(readMonthlyBudgetUsd()).toBeNull();
		process.env.KOSHA_MONTHLY_BUDGET_USD = "abc";
		expect(readMonthlyBudgetUsd()).toBeNull();
	});
});

function makeEntry(ts: number, tenant: string | null, usd: number) {
	return {
		ts,
		provider: "openai",
		modelId: "gpt-4o-mini",
		requested: "x",
		tenant,
		estimatedUsd: usd,
		estimatedInputTokens: 10,
		estimatedOutputTokens: 10,
		upstreamStatus: 200,
	};
}
