/**
 * Cost primitives (estimate + ledger + budget gate) and proxy wiring.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendLedgerEntry,
	estimateRequestCost,
	readMonthlyBudgetUsd,
	readSpendForMonth,
	trimLedgerPartitions,
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

	it("writes the entry to the current month's partition, not the legacy file", async () => {
		const now = Date.now();
		await appendLedgerEntry(
			{
				ts: now,
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
		// The row lands in ledger-YYYY-MM.jsonl, a sibling of the legacy path.
		const raw = await readFile(partitionFile(dir, now), "utf-8");
		const row = JSON.parse(raw.trim());
		expect(row.modelId).toBe("gpt-4o-mini");
		expect(row.estimatedUsd).toBeCloseTo(0.05);
		// The legacy append-only file is NOT written by new appends.
		await expect(readFile(path, "utf-8")).rejects.toThrow();
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

describe("ledger partitioning", () => {
	let dir: string;
	let path: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "kosha-part-"));
		path = join(dir, "ledger.jsonl");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("readSpendForMonth reads only the queried month's partition", async () => {
		// Hand-write two partition files: one for "now", one for last month.
		// Each carries an entry in its own month with a different tenant so we
		// can tell them apart. readSpendForMonth(now) must only see "now".
		const now = Date.now();
		const lastMonth = new Date(new Date(now).setMonth(new Date(now).getMonth() - 1)).getTime();
		await writeFile(
			partitionFile(dir, now),
			`${JSON.stringify(makeEntry(now, "cur", 2))}\n`,
			"utf-8",
		);
		await writeFile(
			partitionFile(dir, lastMonth),
			`${JSON.stringify(makeEntry(lastMonth, "cur", 40))}\n`,
			"utf-8",
		);

		// Querying "now" must not scan last month's partition.
		expect(await readSpendForMonth(now, "cur", path)).toBeCloseTo(2);
		// And querying last month must not scan this month's partition.
		expect(await readSpendForMonth(lastMonth, "cur", path)).toBeCloseTo(40);
	});

	it("counts legacy ledger.jsonl entries for backward compat", async () => {
		// Simulate a pre-partitioning install: history lives in ledger.jsonl.
		const now = Date.now();
		await writeFile(path, `${JSON.stringify(makeEntry(now, "legacy", 3))}\n`, "utf-8");
		expect(await readSpendForMonth(now, "legacy", path)).toBeCloseTo(3);
	});

	it("sums the month partition and the legacy file together", async () => {
		// Same month present in BOTH the partition (new appends) and the legacy
		// file (leftover history). Both must count — no double-counting risk
		// because they're physically different files.
		const now = Date.now();
		await writeFile(partitionFile(dir, now), `${JSON.stringify(makeEntry(now, "t", 1))}\n`, "utf-8");
		await writeFile(path, `${JSON.stringify(makeEntry(now, "t", 2))}\n`, "utf-8");
		expect(await readSpendForMonth(now, "t", path)).toBeCloseTo(3);
	});

	it("ignores legacy entries that fall outside the queried month", async () => {
		const now = Date.now();
		const old = new Date(new Date(now).setMonth(new Date(now).getMonth() - 3)).getTime();
		// Legacy file holds only an old-month entry.
		await writeFile(path, `${JSON.stringify(makeEntry(old, "t", 7))}\n`, "utf-8");
		expect(await readSpendForMonth(now, "t", path)).toBeCloseTo(0);
	});
});

describe("ledger retention", () => {
	let dir: string;
	let path: string;
	const priorEnv = process.env.KOSHA_LEDGER_RETENTION_MONTHS;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "kosha-trim-"));
		path = join(dir, "ledger.jsonl");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		if (priorEnv === undefined) delete process.env.KOSHA_LEDGER_RETENTION_MONTHS;
		else process.env.KOSHA_LEDGER_RETENTION_MONTHS = priorEnv;
	});

	it("trimLedgerPartitions drops partitions older than the window, keeps the rest", async () => {
		// Pin "now" to 2026-07 so the window is deterministic regardless of the
		// real wall clock. With retention = 12 we keep [2025-08 .. 2026-07].
		const now = Date.UTC(2026, 6, 15); // 2026-07-15
		const keepMonth = Date.UTC(2026, 5, 1); // 2026-06 — inside the window
		const dropMonth = Date.UTC(2024, 0, 1); // 2024-01 — outside the window
		await writeFile(partitionFile(dir, keepMonth), `${JSON.stringify(makeEntry(keepMonth, "t", 1))}\n`, "utf-8");
		await writeFile(partitionFile(dir, dropMonth), `${JSON.stringify(makeEntry(dropMonth, "t", 1))}\n`, "utf-8");

		const removed = await trimLedgerPartitions(path, now, 12);
		expect(removed).toBe(1);

		const remaining = await readdir(dir);
		expect(remaining).toContain(partitionName(keepMonth));
		expect(remaining).not.toContain(partitionName(dropMonth));
	});

	it("never touches the legacy ledger.jsonl during trim", async () => {
		const now = Date.UTC(2026, 6, 15);
		// Legacy file with an old entry — must survive trim even though its
		// entry is ancient. Only ledger-YYYY-MM.jsonl siblings are eligible.
		await writeFile(path, `${JSON.stringify(makeEntry(Date.UTC(2020, 0, 1), "t", 1))}\n`, "utf-8");
		await trimLedgerPartitions(path, now, 1);
		const remaining = await readdir(dir);
		expect(remaining).toContain("ledger.jsonl");
	});

	it("append opportunistically trims using KOSHA_LEDGER_RETENTION_MONTHS", async () => {
		// Tight window so we can force a drop with synthetic timestamps.
		process.env.KOSHA_LEDGER_RETENTION_MONTHS = "2";
		const now = Date.UTC(2026, 6, 15); // current month 2026-07, keep [2026-06..2026-07]
		const keepMonth = Date.UTC(2026, 5, 10); // 2026-06 — kept
		const dropMonth = Date.UTC(2024, 0, 10); // 2024-01 — dropped
		await writeFile(partitionFile(dir, keepMonth), `${JSON.stringify(makeEntry(keepMonth, "t", 1))}\n`, "utf-8");
		await writeFile(partitionFile(dir, dropMonth), `${JSON.stringify(makeEntry(dropMonth, "t", 1))}\n`, "utf-8");

		// Appending a current-month entry triggers the opportunistic sweep.
		await appendLedgerEntry(makeEntry(now, "t", 0.1), path);

		const remaining = await readdir(dir);
		expect(remaining).toContain(partitionName(keepMonth));
		expect(remaining).toContain(partitionName(now));
		expect(remaining).not.toContain(partitionName(dropMonth));

		// And the just-written partition is readable through the public API.
		expect(await readSpendForMonth(now, "t", path)).toBeCloseTo(0.1);
	});

	it("retention default (unset env) keeps a 12-month window", async () => {
		delete process.env.KOSHA_LEDGER_RETENTION_MONTHS;
		const now = Date.UTC(2026, 6, 15); // current month 2026-07
		// Default 12-month window keeps [2025-08 .. 2026-07].
		const oldestKept = Date.UTC(2025, 7, 1); // 2025-08 — 11 months back
		const firstDropped = Date.UTC(2025, 6, 1); // 2025-07 — exactly 12 months back
		await writeFile(partitionFile(dir, oldestKept), `${JSON.stringify(makeEntry(oldestKept, "t", 1))}\n`, "utf-8");
		await writeFile(partitionFile(dir, firstDropped), `${JSON.stringify(makeEntry(firstDropped, "t", 1))}\n`, "utf-8");

		const removed = await trimLedgerPartitions(path, now);
		expect(removed).toBe(1);

		const remaining = await readdir(dir);
		expect(remaining).toContain(partitionName(oldestKept));
		expect(remaining).not.toContain(partitionName(firstDropped));
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

/** ledger-YYYY-MM.jsonl name for the UTC month containing ts — mirrors the
 *  production naming so tests independently assert the on-disk contract. */
function partitionName(ts: number): string {
	const d = new Date(ts);
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	return `ledger-${d.getUTCFullYear()}-${mm}.jsonl`;
}

function partitionFile(dir: string, ts: number): string {
	return join(dir, partitionName(ts));
}
