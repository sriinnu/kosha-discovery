/**
 * kosha-discovery — Zero-dependency token usage + cost tally primitives.
 *
 * Pure functions only: no fs/network/process imports, so this module is
 * safe to import in a browser, a Workers/edge runtime, or any bundle that
 * cares about staying isomorphic. Node-only concerns (ledger I/O, budget
 * gates) live in ./cost.js instead — import that separately if you need them.
 *
 * Mirrors the normalize → resolve pricing → estimate → tally shape so
 * consumers (tokmeter, Runic, a browser cost calculator) don't each
 * reinvent cross-provider usage normalization or rate math.
 * @module
 */

import type { ModelPricing } from "./types.js";

/** Canonical, provider-agnostic token usage shape. */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	/** Cache-read ("hit") input tokens, if the provider reports them separately. */
	cachedInputTokens?: number;
	/** Cache-write input tokens (Anthropic-style cache creation), if reported. */
	cacheWriteTokens?: number;
	/** Reasoning/thinking output tokens, if the provider bills or reports them separately. */
	reasoningTokens?: number;
}

/** `TokenUsage` plus a derived total. Returned by `normalizeTokenUsage`. */
export interface NormalizedTokenUsage extends TokenUsage {
	totalTokens: number;
}

/** Alternate field spellings accepted per canonical field, checked in order. */
const FIELD_ALIASES: Record<keyof TokenUsage, readonly string[]> = {
	inputTokens: ["inputTokens", "input_tokens", "prompt_tokens", "promptTokens"],
	outputTokens: ["outputTokens", "output_tokens", "completion_tokens", "completionTokens"],
	cachedInputTokens: [
		"cachedInputTokens",
		"cached_tokens",
		"cachedTokens",
		"cache_read_input_tokens",
		"cacheReadInputTokens",
	],
	cacheWriteTokens: ["cacheWriteTokens", "cache_creation_input_tokens", "cacheCreationInputTokens"],
	reasoningTokens: ["reasoningTokens", "reasoning_tokens", "completion_tokens_details.reasoning_tokens"],
};

function readField(raw: Record<string, unknown>, aliases: readonly string[]): number | undefined {
	for (const key of aliases) {
		const value = key.includes(".") ? readPath(raw, key.split(".")) : raw[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function readPath(raw: Record<string, unknown>, path: string[]): unknown {
	let cur: unknown = raw;
	for (const segment of path) {
		if (!cur || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[segment];
	}
	return cur;
}

/**
 * Normalize a raw, provider-shaped usage object (OpenAI `prompt_tokens` /
 * `completion_tokens`, Anthropic `input_tokens` / `output_tokens` /
 * `cache_read_input_tokens`, etc.) into the canonical `TokenUsage` shape.
 *
 * Returns `null` when neither an input nor output token count can be found —
 * that's "not a usage object," not "zero usage."
 */
export function normalizeTokenUsage(raw: Record<string, unknown> | null | undefined): NormalizedTokenUsage | null {
	if (!raw || typeof raw !== "object") return null;

	const inputTokens = readField(raw, FIELD_ALIASES.inputTokens) ?? 0;
	const outputTokens = readField(raw, FIELD_ALIASES.outputTokens) ?? 0;
	const cachedInputTokens = readField(raw, FIELD_ALIASES.cachedInputTokens);
	const cacheWriteTokens = readField(raw, FIELD_ALIASES.cacheWriteTokens);
	const reasoningTokens = readField(raw, FIELD_ALIASES.reasoningTokens);

	const hasAnyUsage =
		inputTokens > 0 ||
		outputTokens > 0 ||
		(cachedInputTokens ?? 0) > 0 ||
		(cacheWriteTokens ?? 0) > 0 ||
		(reasoningTokens ?? 0) > 0;
	if (!hasAnyUsage) return null;

	const totalTokens = inputTokens + outputTokens + (cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0) + (reasoningTokens ?? 0);

	return {
		inputTokens,
		outputTokens,
		...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		totalTokens,
	};
}

/** Per-MTok rates are stored in USD; price = (tokens / 1_000_000) * rate. */
function tokensTimesRate(tokens: number, perMillion: number | undefined): number {
	return typeof perMillion === "number" ? (tokens / 1_000_000) * perMillion : 0;
}

/** USD breakdown returned by `estimateUsdCost`. */
export interface UsdCostBreakdown {
	inputUsd: number;
	outputUsd: number;
	cachedInputUsd: number;
	cacheWriteUsd: number;
	reasoningUsd: number;
	totalUsd: number;
}

/**
 * Estimate USD cost for one usage record against one model's pricing.
 * Reasoning tokens price against `reasoningOutputPerMillion` when the model
 * has it, falling back to the plain output rate otherwise — most providers
 * that report reasoning tokens separately still bill them at the output rate.
 */
export function estimateUsdCost(usage: TokenUsage, pricing: ModelPricing): UsdCostBreakdown {
	const inputUsd = tokensTimesRate(usage.inputTokens, pricing.inputPerMillion);
	const outputUsd = tokensTimesRate(usage.outputTokens, pricing.outputPerMillion);
	const cachedInputUsd = usage.cachedInputTokens
		? tokensTimesRate(usage.cachedInputTokens, pricing.cacheReadPerMillion)
		: 0;
	const cacheWriteUsd = usage.cacheWriteTokens
		? tokensTimesRate(usage.cacheWriteTokens, pricing.cacheWritePerMillion)
		: 0;
	const reasoningUsd = usage.reasoningTokens
		? tokensTimesRate(usage.reasoningTokens, pricing.reasoningOutputPerMillion ?? pricing.outputPerMillion)
		: 0;

	return {
		inputUsd,
		outputUsd,
		cachedInputUsd,
		cacheWriteUsd,
		reasoningUsd,
		totalUsd: inputUsd + outputUsd + cachedInputUsd + cacheWriteUsd + reasoningUsd,
	};
}

/** One call record as consumed by `tallyCosts`. */
export interface TallyCall {
	modelId: string;
	usage: TokenUsage;
}

/** Per-model subtotal within a `tallyCosts` result. */
export interface TallyModelSubtotal extends UsdCostBreakdown {
	modelId: string;
	calls: number;
	usage: TokenUsage;
}

/** Aggregate result of `tallyCosts`. */
export interface TallyResult extends UsdCostBreakdown {
	calls: number;
	byModel: TallyModelSubtotal[];
	/** modelIds `resolvePricing` returned `null` for — cost for these is excluded from the totals. */
	unpriced: string[];
}

/**
 * Aggregate USD cost and token totals across heterogeneous calls, grouped by
 * model. Pricing is resolved per model via the injected `resolvePricing`
 * callback so the caller decides the source (kosha's live registry, a
 * static map, a cached snapshot) — this function does no I/O of its own.
 */
export function tallyCosts(
	calls: readonly TallyCall[],
	resolvePricing: (modelId: string) => ModelPricing | null | undefined,
): TallyResult {
	const byModel = new Map<string, TallyModelSubtotal>();
	const unpriced = new Set<string>();

	for (const call of calls) {
		const pricing = resolvePricing(call.modelId);
		if (!pricing) {
			unpriced.add(call.modelId);
			continue;
		}

		const cost = estimateUsdCost(call.usage, pricing);
		const existing = byModel.get(call.modelId);
		if (!existing) {
			byModel.set(call.modelId, {
				modelId: call.modelId,
				calls: 1,
				usage: { ...call.usage },
				...cost,
			});
			continue;
		}

		existing.calls += 1;
		existing.usage = mergeUsage(existing.usage, call.usage);
		existing.inputUsd += cost.inputUsd;
		existing.outputUsd += cost.outputUsd;
		existing.cachedInputUsd += cost.cachedInputUsd;
		existing.cacheWriteUsd += cost.cacheWriteUsd;
		existing.reasoningUsd += cost.reasoningUsd;
		existing.totalUsd += cost.totalUsd;
	}

	const subtotals = [...byModel.values()];
	return {
		calls: calls.length,
		byModel: subtotals,
		unpriced: [...unpriced],
		inputUsd: sumBy(subtotals, (s) => s.inputUsd),
		outputUsd: sumBy(subtotals, (s) => s.outputUsd),
		cachedInputUsd: sumBy(subtotals, (s) => s.cachedInputUsd),
		cacheWriteUsd: sumBy(subtotals, (s) => s.cacheWriteUsd),
		reasoningUsd: sumBy(subtotals, (s) => s.reasoningUsd),
		totalUsd: sumBy(subtotals, (s) => s.totalUsd),
	};
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) || undefined,
		cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) || undefined,
		reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) || undefined,
	};
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
	let total = 0;
	for (const item of items) total += pick(item);
	return total;
}
