/**
 * `kosha spend` — roll up the JSONL spend ledger written by the proxy.
 *
 * No registry / network access; pure file read + arithmetic. Supports
 * `--since <iso-date>`, `--tenant <name>`, and `--json` for programmatic
 * consumers.
 * @module
 */

import { readFile, readdir } from "fs/promises";
import { basename, dirname, join } from "node:path";
import { c, CYAN, DIM, GREEN } from "./cli-format.js";
import { DEFAULT_LEDGER_PATH, isRequestRow, type LedgerEntry, ledgerRowUsd } from "./cost.js";

interface SpendFlags {
	since?: string | boolean;
	until?: string | boolean;
	tenant?: string | boolean;
	json?: string | boolean;
	ledger?: string | boolean;
}

interface BucketSummary {
	count: number;
	totalUsd: number;
	totalInputTokens: number;
	totalOutputTokens: number;
}

export async function cmdSpend(_unused: unknown, flags: Record<string, string | boolean>): Promise<void> {
	const f: SpendFlags = flags;
	const ledgerPath = typeof f.ledger === "string" ? f.ledger : DEFAULT_LEDGER_PATH;
	const since = typeof f.since === "string" ? Date.parse(f.since) : Number.NEGATIVE_INFINITY;
	const until = typeof f.until === "string" ? Date.parse(f.until) : Number.POSITIVE_INFINITY;
	const tenantFilter = typeof f.tenant === "string" ? f.tenant : null;

	const rows = await loadLedger(ledgerPath);
	const inWindow = rows.filter((r) =>
		r.ts >= (Number.isFinite(since) ? since : Number.NEGATIVE_INFINITY) &&
		r.ts < (Number.isFinite(until) ? until : Number.POSITIVE_INFINITY) &&
		(tenantFilter === null || r.tenant === tenantFilter),
	);

	const total = inWindow.reduce((sum, r) => sum + ledgerRowUsd(r), 0);
	const requests = inWindow.filter(isRequestRow);
	// A request is reconciled when its own row carries upstream usage or a
	// later adjustment row amended it.
	const adjusted = new Set(inWindow.filter((r) => !isRequestRow(r)).map((r) => r.requestId));
	const reconciled = requests.filter((r) => r.usageSource === "upstream" || (r.requestId && adjusted.has(r.requestId))).length;
	const byProvider = bucketBy(inWindow, (r) => r.provider);
	const byModel = bucketBy(inWindow, (r) => `${r.provider}/${r.modelId}`);
	const byTenant = bucketBy(inWindow, (r) => r.tenant ?? "(no tenant)");

	if (f.json) {
		process.stdout.write(`${JSON.stringify({
			ledgerPath,
			rows: requests.length,
			reconciledRows: reconciled,
			totalUsd: total,
			byProvider: Object.fromEntries(byProvider),
			byModel: Object.fromEntries(byModel),
			byTenant: Object.fromEntries(byTenant),
		}, null, 2)}\n`);
		return;
	}

	process.stdout.write(`${c(CYAN, "Spend summary")}  ${c(DIM, `(${requests.length} requests from ${ledgerPath})`)}\n`);
	const label = reconciled === requests.length && reconciled > 0
		? "total (all requests reconciled with upstream usage)"
		: reconciled > 0
			? `total (${reconciled}/${requests.length} requests reconciled with upstream usage, rest estimated)`
			: "total estimated";
	process.stdout.write(`  ${c(GREEN, `$${total.toFixed(4)}`)}  ${c(DIM, label)}\n\n`);
	renderBucket("By provider", byProvider);
	renderBucket("By model", byModel);
	renderBucket("By tenant", byTenant);
}

async function loadLedger(path: string): Promise<LedgerEntry[]> {
	const rows: LedgerEntry[] = [];
	const ingest = async (file: string): Promise<void> => {
		let raw: string;
		try {
			raw = await readFile(file, "utf-8");
		} catch (err) {
			// Missing file is fine — the legacy ledger and any given monthly
			// partition may not exist yet.
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
			throw err;
		}
		for (const line of raw.split("\n")) {
			if (!line) continue;
			try {
				rows.push(JSON.parse(line) as LedgerEntry);
			} catch {
				// skip corrupt line
			}
		}
	};
	// Legacy append-only ledger.jsonl (pre-rotation) plus the monthly
	// ledger-YYYY-MM.jsonl partitions written since rotation shipped.
	await ingest(path);
	try {
		const dir = dirname(path);
		for (const entry of await readdir(dir)) {
			if (entry !== basename(path) && entry.startsWith("ledger-") && entry.endsWith(".jsonl")) {
				await ingest(join(dir, entry));
			}
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
	}
	return rows;
}

function bucketBy(rows: LedgerEntry[], keyFn: (row: LedgerEntry) => string): Map<string, BucketSummary> {
	const out = new Map<string, BucketSummary>();
	for (const row of rows) {
		const key = keyFn(row);
		const cur = out.get(key) ?? {
			count: 0,
			totalUsd: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
		};
		if (isRequestRow(row)) {
			cur.count += 1;
			cur.totalInputTokens += row.actualInputTokens ?? row.estimatedInputTokens ?? 0;
			cur.totalOutputTokens += row.actualOutputTokens ?? row.estimatedOutputTokens ?? 0;
		} else {
			cur.totalInputTokens += row.adjustmentInputTokens ?? 0;
			cur.totalOutputTokens += row.adjustmentOutputTokens ?? 0;
		}
		cur.totalUsd += ledgerRowUsd(row);
		out.set(key, cur);
	}
	return new Map(Array.from(out.entries()).sort((a, b) => b[1].totalUsd - a[1].totalUsd));
}

function renderBucket(title: string, bucket: Map<string, BucketSummary>): void {
	if (bucket.size === 0) return;
	process.stdout.write(`  ${c(CYAN, title)}\n`);
	for (const [key, sum] of bucket) {
		process.stdout.write(
			`    ${c(GREEN, `$${sum.totalUsd.toFixed(4)}`)}  ${key.padEnd(28)} ${c(DIM, `${sum.count} req`)}\n`,
		);
	}
	process.stdout.write("\n");
}
