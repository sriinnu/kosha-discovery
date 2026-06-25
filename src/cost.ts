/**
 * kosha-discovery — Cost primitives shared by the proxy and the CLI.
 *
 * Three pieces, all pure synthesis over the model + provider catalog:
 *   - Pre-flight cost estimation (input + expected-output tokens × rates).
 *   - JSONL spend ledger persisted to `~/.kosha/ledger.jsonl` so downstream
 *     dashboards / `kosha spend` can read a stable file.
 *   - Monthly budget gate driven by `KOSHA_MONTHLY_BUDGET_USD`.
 *
 * No tokenizer dependency — request bodies travel through the proxy
 * untouched, so we approximate input tokens with a coarse char→token ratio.
 * @module
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "fs/promises";
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
 * Read the ledger and sum estimated USD spend for entries falling in the
 * calendar month that contains `nowMs`. Tenant scopes the sum when given.
 */
export async function readSpendForMonth(nowMs: number, tenant?: string | null, ledgerPath = DEFAULT_LEDGER_PATH): Promise<number> {
	const cutoffStart = startOfMonth(nowMs);
	const cutoffEnd = startOfNextMonth(nowMs);
	let total = 0;
	try {
		const raw = await readFile(ledgerPath, "utf-8");
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
	} catch (err: unknown) {
		// Missing ledger is a clean "spent $0 this month" — not an error.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
		throw err;
	}
	return total;
}

/**
 * Append one ledger entry atomically. The file is JSONL — one record per
 * line — and writes are append-only so concurrent processes don't clobber
 * each other. A best-effort atomic create-and-rename is used for the very
 * first write so a torn write on a previously empty file can't poison
 * future reads.
 */
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

export async function appendLedgerEntry(entry: LedgerEntry, ledgerPath = DEFAULT_LEDGER_PATH): Promise<void> {
	await mkdir(dirname(ledgerPath), { recursive: true });
	const line = `${JSON.stringify(sanitizeEntry(entry))}\n`;
	try {
		await appendFile(ledgerPath, line, "utf-8");
	} catch (err: unknown) {
		// If append fails (e.g. permissions) we just swallow — ledger is
		// observability, not load-bearing routing state. A best-effort
		// create-and-rename gets us going on a fresh install.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			const tmp = `${ledgerPath}.${randomBytes(4).toString("hex")}.tmp`;
			try {
				await writeFile(tmp, line, "utf-8");
				await rename(tmp, ledgerPath);
			} catch {
				// give up silently
			}
		}
	}
}

function startOfMonth(nowMs: number): number {
	const d = new Date(nowMs);
	return new Date(d.getUTCFullYear(), d.getUTCMonth(), 1).getTime();
}

function startOfNextMonth(nowMs: number): number {
	const d = new Date(nowMs);
	return new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 1).getTime();
}
