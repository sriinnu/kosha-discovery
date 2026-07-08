/**
 * kosha-discovery — Cost primitives shared by the proxy and the CLI.
 *
 * Three pieces, all pure synthesis over the model + provider catalog:
 *   - Pre-flight cost estimation (input + expected-output tokens × rates).
 *   - JSONL spend ledger persisted under `~/.kosha/`, partitioned one file
 *     per calendar month (`ledger-YYYY-MM.jsonl`) so the budget gate only
 *     ever scans the month it cares about — not the full history. The legacy
 *     append-only `ledger.jsonl` is still read for backward compat so
 *     existing installs keep working until it stops growing.
 *   - Monthly budget gate driven by `KOSHA_MONTHLY_BUDGET_USD`.
 *
 * No tokenizer dependency — request bodies travel through the proxy
 * untouched, so we approximate input tokens with a coarse char→token ratio.
 * @module
 */

import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "fs/promises";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import type { ModelCard } from "./types.js";

/** A single completion record written to the ledger. */
export interface LedgerEntry {
	ts: number;
	provider: string;
	modelId: string;
	requested: string;
	tenant: string | null;
	/** Estimated total cost in USD. */
	estimatedUsd: number;
	/** Input tokens estimated from the forwarded request body. */
	estimatedInputTokens: number;
	/** Output tokens the caller asked for (or our fallback). */
	estimatedOutputTokens: number;
	upstreamStatus: number;
}

export const DEFAULT_LEDGER_PATH: string = join(homedir(), ".kosha", "ledger.jsonl");

/**
 * How many monthly partitions to retain on disk. Older partitions are
 * trimmed opportunistically on append. Tunable via
 * `KOSHA_LEDGER_RETENTION_MONTHS`; non-positive / unparseable values fall
 * back to the default. The legacy `ledger.jsonl` is never trimmed by the
 * partition sweeper — only `ledger-YYYY-MM.jsonl` siblings are.
 */
const DEFAULT_RETENTION_MONTHS = 12;

/**
 * Conservative chars-per-token used when we don't have a tokenizer wired up.
 * This is intentionally lower than the OpenAI rule of thumb (~4) so the
 * estimate skews high; underestimating spend is the dangerous direction.
 */
const CHARS_PER_TOKEN = 3.5;

/** Output tokens to assume when the caller doesn't request `max_tokens`. */
const DEFAULT_EXPECTED_OUTPUT_TOKENS = 512;

/** Per-MTok rates are stored in USD; price = (tokens/1_000_000) * rate. */
function tokensTimesRate(tokens: number, perMillion: number): number {
	return (tokens / 1_000_000) * perMillion;
}

export interface CostEstimate {
	estimatedUsd: number;
	inputTokens: number;
	expectedOutputTokens: number;
}

/**
 * Estimate the USD cost of forwarding `requestBody` to `model`. Returns null
 * when the model has no usable pricing — the caller should treat that as
 * "cost unknown" rather than free.
 */
export function estimateRequestCost(model: ModelCard, requestBody: Record<string, unknown>): CostEstimate | null {
	const pricing = model.pricing;
	if (!pricing) return null;
	if (typeof pricing.inputPerMillion !== "number" || typeof pricing.outputPerMillion !== "number") return null;

	const inputTokens = approximateInputTokens(requestBody);
	const expectedOutputTokens =
		typeof requestBody.max_tokens === "number" && requestBody.max_tokens > 0
			? Math.floor(requestBody.max_tokens)
			: DEFAULT_EXPECTED_OUTPUT_TOKENS;

	const estimatedUsd =
		tokensTimesRate(inputTokens, pricing.inputPerMillion) +
		tokensTimesRate(expectedOutputTokens, pricing.outputPerMillion);

	return { estimatedUsd, inputTokens, expectedOutputTokens };
}

/**
 * Approximate input token count by walking the OpenAI-style `messages`
 * array, falling back to total stringified body length. Intentionally
 * conservative (small CHARS_PER_TOKEN) so the estimate doesn't undershoot.
 */
function approximateInputTokens(body: Record<string, unknown>): number {
	const messages = body.messages;
	if (Array.isArray(messages)) {
		let chars = 0;
		for (const msg of messages) {
			if (!msg || typeof msg !== "object") continue;
			const content = (msg as { content?: unknown }).content;
			if (typeof content === "string") {
				chars += content.length;
			} else if (Array.isArray(content)) {
				for (const part of content) {
					if (typeof part === "string") chars += part.length;
					else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
						chars += (part as { text: string }).text.length;
					}
				}
			}
		}
		if (chars > 0) return Math.ceil(chars / CHARS_PER_TOKEN);
	}
	const fallback = JSON.stringify(body).length;
	return Math.ceil(fallback / CHARS_PER_TOKEN);
}

/**
 * Read `KOSHA_MONTHLY_BUDGET_USD` (if any). Returns null when no budget is
 * configured — `enforceMonthlyBudget` then becomes a no-op.
 */
export function readMonthlyBudgetUsd(): number | null {
	const raw = process.env.KOSHA_MONTHLY_BUDGET_USD;
	if (!raw) return null;
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Sum estimated USD spend for entries falling in the calendar month that
 * contains `nowMs`. Tenant scopes the sum when given.
 *
 * Reads only the month's partition (`ledger-YYYY-MM.jsonl` next to
 * `ledgerPath`) plus, for backward compat, the legacy append-only
 * `ledgerPath` itself — so existing installs whose history still lives in
 * the un-partitioned file keep counting until that file stops growing. At
 * most two files are read, never the full history.
 */
export async function readSpendForMonth(nowMs: number, tenant?: string | null, ledgerPath = DEFAULT_LEDGER_PATH): Promise<number> {
	const cutoffStart = startOfMonth(nowMs);
	const cutoffEnd = startOfNextMonth(nowMs);
	// The month partition is the hot path; the legacy file is the fallback
	// for pre-partitioning history. Order matters only for readability —
	// both are filtered by the same ts window below.
	const sources = [partitionPathFor(ledgerPath, nowMs), ledgerPath];
	let total = 0;
	for (const file of sources) {
		let raw: string;
		try {
			raw = await readFile(file, "utf-8");
		} catch (err: unknown) {
			// Missing file (partition not yet created, or legacy absent) is
			// a clean "nothing here" — try the next source.
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
			throw err;
		}
		for (const line of raw.split("\n")) {
			if (!line) continue;
			let row: LedgerEntry;
			try {
				row = JSON.parse(line) as LedgerEntry;
			} catch {
				continue; // skip corrupt lines, don't crash budget enforcement
			}
			if (row.ts < cutoffStart || row.ts >= cutoffEnd) continue;
			if (tenant && row.tenant !== tenant) continue;
			if (typeof row.estimatedUsd === "number") total += row.estimatedUsd;
		}
	}
	return total;
}

/** Strip control characters and bound length on a ledger string field. The
 *  ledger records caller-supplied values (modelId, tenant tag, the original
 *  requested model string), so we sanitize them before writing to disk: each
 *  line stays a single, well-formed JSON record. Without this, a crafted
 *  model id with embedded CR/LF could split one row into two. */
function sanitizeLedgerString(value: string): string {
	return value.replace(/[\r\n\t]/g, "").slice(0, 256);
}

/** Apply sanitizeLedgerString to every string field of the entry. Numeric
 *  fields are pass-through. */
function sanitizeEntry(entry: LedgerEntry): LedgerEntry {
	return {
		ts: entry.ts,
		provider: sanitizeLedgerString(entry.provider),
		modelId: sanitizeLedgerString(entry.modelId),
		requested: sanitizeLedgerString(entry.requested),
		tenant: entry.tenant === null ? null : sanitizeLedgerString(entry.tenant),
		estimatedUsd: entry.estimatedUsd,
		estimatedInputTokens: entry.estimatedInputTokens,
		estimatedOutputTokens: entry.estimatedOutputTokens,
		upstreamStatus: entry.upstreamStatus,
	};
}

/** `YYYY-MM` (zero-padded month) for the UTC calendar month containing ts.
 *  UTC matches startOfMonth/startOfNextMonth so the partition a row lands in
 *  is exactly the month the budget cutoffs bracket. */
function monthKeyFromTs(ts: number): string {
	const d = new Date(ts);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Parse a `YYYY-MM` key back to its UTC month-start epoch ms, or null when
 *  the shape is wrong. Used by trim to age partitions out deterministically. */
function monthStartFromKey(key: string): number | null {
	const m = /^(\d{4})-(\d{2})$/.exec(key);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]) - 1; // JS months are 0-indexed
	if (month < 0 || month > 11) return null;
	return Date.UTC(year, month, 1);
}

/** Path of the monthly partition file a given ts belongs in. Partitions are
 *  siblings of the legacy ledger file so they share its directory and perms. */
function partitionPathFor(ledgerPath: string, ts: number): string {
	return join(dirname(ledgerPath), `ledger-${monthKeyFromTs(ts)}.jsonl`);
}

/** Read the retention window from `KOSHA_LEDGER_RETENTION_MONTHS`, falling
 *  back to the default for missing/non-positive/unparseable values. */
function readRetentionMonths(): number {
	const raw = process.env.KOSHA_LEDGER_RETENTION_MONTHS;
	if (!raw) return DEFAULT_RETENTION_MONTHS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_MONTHS;
}

/**
 * Drop monthly partition files older than the retention window. Best-effort:
 * errors are swallowed because retention is housekeeping, not correctness.
 * The legacy `ledgerPath` file itself is never touched — only
 * `ledger-YYYY-MM.jsonl` siblings are eligible. Returns the count of
 * partitions removed (handy for tests / a future `kosha ledger trim`).
 *
 * The window is "current month plus `retentionMonths - 1` prior months", so
 * the default of 12 keeps a rolling year. Exported so the CLI can run an
 * explicit sweep without waiting for an append.
 */
export async function trimLedgerPartitions(
	ledgerPath: string,
	nowMs: number,
	retentionMonths: number = readRetentionMonths(),
): Promise<number> {
	const dir = dirname(ledgerPath);
	const d = new Date(nowMs);
	// First month we keep: current month shifted back (N-1). Date.UTC wraps
	// negative months into prior years correctly (month -5 of 2026 → Aug 2025).
	const cutoffStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (retentionMonths - 1), 1);
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		// No directory yet (ENOENT) or unreadable — nothing to trim.
		return 0;
	}
	let removed = 0;
	for (const name of entries) {
		const m = /^ledger-(\d{4})-(\d{2})\.jsonl$/.exec(name);
		if (!m) continue;
		const start = monthStartFromKey(`${m[1]}-${m[2]}`);
		if (start === null || start >= cutoffStart) continue;
		await unlink(join(dir, name)).catch(() => {
			// raced with another sweeper or permission issue — fine, best-effort
		});
		removed += 1;
	}
	return removed;
}

/**
 * Append one ledger entry atomically. The entry is written to the monthly
 * partition for its own `ts` (`ledger-YYYY-MM.jsonl`), keeping each file
 * bounded to a single month so budget reads don't scan the full history.
 *
 * Writes are append-only so concurrent processes don't clobber each other.
 * A best-effort atomic create-and-rename is used if the first append hits
 * ENOENT, so a fresh install comes up cleanly. After the write we run a
 * best-effort retention trim so old partitions age out without a cron job.
 */
export async function appendLedgerEntry(entry: LedgerEntry, ledgerPath = DEFAULT_LEDGER_PATH): Promise<void> {
	await mkdir(dirname(ledgerPath), { recursive: true });
	const partPath = partitionPathFor(ledgerPath, entry.ts);
	const line = `${JSON.stringify(sanitizeEntry(entry))}\n`;
	try {
		await appendFile(partPath, line, "utf-8");
	} catch (err: unknown) {
		// If append fails (e.g. permissions) we just swallow — ledger is
		// observability, not load-bearing routing state. A best-effort
		// create-and-rename gets us going on a fresh install.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			const tmp = `${partPath}.${randomBytes(4).toString("hex")}.tmp`;
			try {
				await writeFile(tmp, line, "utf-8");
				await rename(tmp, partPath);
			} catch {
				// give up silently
			}
		}
	}
	// Opportunistic, best-effort retention sweep. Housekeeping must never
	// break the append — the ledger is observability.
	try {
		await trimLedgerPartitions(ledgerPath, entry.ts);
	} catch {
		// swallowed
	}
}

function startOfMonth(nowMs: number): number {
	const d = new Date(nowMs);
	// Important: pair `getUTCMonth()`/`getUTCFullYear()` with `Date.UTC()`.
	// The numeric `new Date(year, month, …)` constructor interprets its args
	// as LOCAL time, so the previous code drifted by up to ~24h around month
	// boundaries in any non-UTC timezone — breaking budget cutoffs.
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function startOfNextMonth(nowMs: number): number {
	const d = new Date(nowMs);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
