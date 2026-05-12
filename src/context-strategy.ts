/**
 * kosha-discovery — Context-management strategy advisor.
 *
 * Pure synthesis over the model + provider catalog: given where a caller is
 * in their conversation, return ranked options (continue / cache / compact /
 * switch model / long-context tier / batch offload) with rough cost math.
 *
 * No tokenization, no model inference — just arithmetic over the registry.
 * @module
 */

import { getProviderCacheBehavior } from "./provider-catalog.js";
import type { ModelCard, ModelPricing, ProviderCacheBehavior } from "./types.js";

const DEFAULT_EXPECTED_OUTPUT_TOKENS = 1024;
const DEFAULT_EXPECTED_REMAINING_TURNS = 5;
const HEADROOM_WARN_PERCENT = 20;
const HEADROOM_CRITICAL_PERCENT = 10;
const COMPACTION_TARGET_PERCENT = 25;
const CACHE_READ_DISCOUNT_FLOOR = 0.5;

export interface ContextStrategyInput {
	model: ModelCard;
	currentTokens: number;
	expectedRemainingTurns?: number;
	expectedOutputTokens?: number;
	candidateAlternatives?: ModelCard[];
}

export interface ContextSituation {
	tokensUsed: number;
	contextWindow: number;
	headroomTokens: number;
	headroomPercent: number;
	inLongContextTier: boolean;
	longContextThresholdTokens?: number;
}

export interface StrategyOption {
	strategy:
		| "continue"
		| "enable_prompt_cache"
		| "compact_and_continue"
		| "switch_to_long_context_tier"
		| "switch_model"
		| "batch_offload";
	viable: boolean;
	costPerTurnUsd?: number;
	savingsPerTurnUsd?: number;
	notes: string;
	details?: Record<string, unknown>;
}

export interface ContextStrategy {
	model: { id: string; provider: string; contextWindow: number };
	situation: ContextSituation;
	cacheBehavior?: ProviderCacheBehavior;
	options: StrategyOption[];
	recommended: StrategyOption["strategy"];
}

/** Compute ranked context-management options for the given conversation state. */
export function computeContextStrategy(input: ContextStrategyInput): ContextStrategy {
	const {
		model,
		currentTokens,
		expectedRemainingTurns = DEFAULT_EXPECTED_REMAINING_TURNS,
		expectedOutputTokens = DEFAULT_EXPECTED_OUTPUT_TOKENS,
		candidateAlternatives = [],
	} = input;

	const tokensUsed = Math.max(0, Math.floor(currentTokens));
	const headroomTokens = Math.max(0, model.contextWindow - tokensUsed);
	const headroomPercent = model.contextWindow > 0 ? (headroomTokens / model.contextWindow) * 100 : 0;
	const longThreshold = model.pricing?.longContextThresholdTokens;
	const inLongContextTier = longThreshold !== undefined && tokensUsed >= longThreshold;

	const situation: ContextSituation = {
		tokensUsed,
		contextWindow: model.contextWindow,
		headroomTokens,
		headroomPercent: round(headroomPercent, 2),
		inLongContextTier,
		...(longThreshold !== undefined ? { longContextThresholdTokens: longThreshold } : {}),
	};

	const cacheBehavior = getProviderCacheBehavior(model.provider);
	const baselineCost = perTurnCost(model.pricing, tokensUsed, expectedOutputTokens, inLongContextTier);

	const options: StrategyOption[] = [];

	options.push(buildContinueOption(situation, baselineCost, expectedRemainingTurns));
	options.push(buildPromptCacheOption(model, tokensUsed, expectedOutputTokens, baselineCost, cacheBehavior));
	options.push(buildLongContextTierOption(model, situation, baselineCost, expectedOutputTokens));
	options.push(buildCompactionOption(model, situation, baselineCost, expectedOutputTokens, candidateAlternatives));
	options.push(buildSwitchModelOption(model, tokensUsed, expectedOutputTokens, baselineCost, candidateAlternatives));
	options.push(buildBatchOffloadOption(model, tokensUsed, expectedOutputTokens, baselineCost));

	const recommended = pickRecommended(options, situation);

	return {
		model: { id: model.id, provider: model.provider, contextWindow: model.contextWindow },
		situation,
		...(cacheBehavior ? { cacheBehavior } : {}),
		options,
		recommended,
	};
}

function buildContinueOption(
	situation: ContextSituation,
	baselineCost: number | undefined,
	expectedRemainingTurns: number,
): StrategyOption {
	const viable = situation.headroomPercent > 0;
	const tone =
		situation.headroomPercent < HEADROOM_CRITICAL_PERCENT
			? `Only ${situation.headroomPercent.toFixed(1)}% headroom — likely to overflow within 1–2 turns.`
			: situation.headroomPercent < HEADROOM_WARN_PERCENT
				? `${situation.headroomPercent.toFixed(1)}% headroom — comfortable for a few more turns.`
				: `${situation.headroomPercent.toFixed(1)}% headroom — no pressure.`;

	return {
		strategy: "continue",
		viable,
		...(baselineCost !== undefined ? { costPerTurnUsd: round(baselineCost, 6) } : {}),
		notes: tone,
		details: {
			projectedCostForRemainingTurnsUsd:
				baselineCost !== undefined ? round(baselineCost * expectedRemainingTurns, 6) : undefined,
			inLongContextTier: situation.inLongContextTier,
		},
	};
}

function buildPromptCacheOption(
	model: ModelCard,
	currentTokens: number,
	expectedOutputTokens: number,
	baselineCost: number | undefined,
	cacheBehavior: ProviderCacheBehavior | undefined,
): StrategyOption {
	if (!cacheBehavior || cacheBehavior.mode === "none") {
		return {
			strategy: "enable_prompt_cache",
			viable: false,
			notes:
				cacheBehavior?.mode === "none"
					? "Provider has no documented prompt cache."
					: "Cache behavior for this provider has not been curated yet.",
		};
	}

	const cacheReadRate = model.pricing?.cacheReadPerMillion;
	const inputRate = model.pricing?.inputPerMillion;
	const outputRate = model.pricing?.outputPerMillion;
	const canEstimate = cacheReadRate !== undefined && inputRate !== undefined && outputRate !== undefined;

	const cachedTurnCost = canEstimate
		? (currentTokens * cacheReadRate + expectedOutputTokens * outputRate) / 1_000_000
		: undefined;
	const savings = baselineCost !== undefined && cachedTurnCost !== undefined ? baselineCost - cachedTurnCost : undefined;

	const ttlGuidance =
		cacheBehavior.mode === "explicit"
			? cacheBehavior.ttlTiers
				? `Pick a TTL from: ${cacheBehavior.ttlTiers.join(", ")}.`
				: cacheBehavior.maxTtlSeconds
					? `Set TTL up to ${cacheBehavior.maxTtlSeconds}s (default ${cacheBehavior.defaultTtlSeconds ?? "provider-defined"}).`
					: "Caller picks TTL."
			: cacheBehavior.mode === "automatic"
				? `Provider manages TTL${cacheBehavior.approximateTtlSeconds ? ` (~${cacheBehavior.approximateTtlSeconds}s typical)` : ""}.`
				: "Gateway forwards cache_control to the routed model — TTL inherits from the underlying provider.";

	return {
		strategy: "enable_prompt_cache",
		viable: true,
		...(cachedTurnCost !== undefined ? { costPerTurnUsd: round(cachedTurnCost, 6) } : {}),
		...(savings !== undefined ? { savingsPerTurnUsd: round(savings, 6) } : {}),
		notes:
			cacheReadRate !== undefined &&
			inputRate !== undefined &&
			inputRate > 0 &&
			cacheReadRate / inputRate < CACHE_READ_DISCOUNT_FLOOR
				? `Cache reads cost ${round((cacheReadRate / inputRate) * 100, 1)}% of base input — meaningful savings on a stable prefix. ${ttlGuidance}`
				: `Mode: ${cacheBehavior.mode}. ${ttlGuidance}`,
		details: {
			cacheMode: cacheBehavior.mode,
			ttlTiers: cacheBehavior.ttlTiers,
			defaultTtlSeconds: cacheBehavior.defaultTtlSeconds,
			maxTtlSeconds: cacheBehavior.maxTtlSeconds,
			approximateTtlSeconds: cacheBehavior.approximateTtlSeconds,
			cacheReadRatePerMillion: cacheReadRate,
			documented: cacheBehavior.documented,
		},
	};
}

function buildLongContextTierOption(
	model: ModelCard,
	situation: ContextSituation,
	baselineCost: number | undefined,
	expectedOutputTokens: number,
): StrategyOption {
	const threshold = model.pricing?.longContextThresholdTokens;
	const longIn = model.pricing?.longContextInputPerMillion;
	const longOut = model.pricing?.longContextOutputPerMillion;

	if (threshold === undefined || longIn === undefined || longOut === undefined) {
		return {
			strategy: "switch_to_long_context_tier",
			viable: false,
			notes: "Model does not publish a tiered long-context price — single rate applies regardless of size.",
		};
	}

	const tieredCost = (situation.tokensUsed * longIn + expectedOutputTokens * longOut) / 1_000_000;
	const delta = baselineCost !== undefined ? tieredCost - baselineCost : undefined;

	return {
		strategy: "switch_to_long_context_tier",
		viable: true,
		costPerTurnUsd: round(tieredCost, 6),
		...(delta !== undefined ? { savingsPerTurnUsd: round(-delta, 6) } : {}),
		notes: situation.inLongContextTier
			? `Already in long-context tier (>${threshold} tokens). Cost is what it is — consider compaction or a smaller-context-priced model instead.`
			: `You're under the ${threshold}-token threshold; growing past it triggers tiered pricing (input ${longIn}/M, output ${longOut}/M).`,
		details: { thresholdTokens: threshold, longInputPerMillion: longIn, longOutputPerMillion: longOut },
	};
}

function buildCompactionOption(
	model: ModelCard,
	situation: ContextSituation,
	baselineCost: number | undefined,
	expectedOutputTokens: number,
	candidateAlternatives: ModelCard[],
): StrategyOption {
	if (situation.tokensUsed === 0) {
		return { strategy: "compact_and_continue", viable: false, notes: "Nothing to compact yet." };
	}

	const targetTokens = Math.max(1024, Math.floor(model.contextWindow * (COMPACTION_TARGET_PERCENT / 100)));
	const tokensReclaimed = Math.max(0, situation.tokensUsed - targetTokens);
	const summarizer = pickCheapestChatModel(candidateAlternatives, model);
	const summarizationCost =
		summarizer?.pricing?.inputPerMillion !== undefined
			? (situation.tokensUsed * summarizer.pricing.inputPerMillion +
					targetTokens * (summarizer.pricing.outputPerMillion ?? 0)) /
				1_000_000
			: undefined;

	const postCompactionTurnCost =
		model.pricing?.inputPerMillion !== undefined && model.pricing?.outputPerMillion !== undefined
			? (targetTokens * model.pricing.inputPerMillion + expectedOutputTokens * model.pricing.outputPerMillion) / 1_000_000
			: undefined;
	const savings =
		baselineCost !== undefined && postCompactionTurnCost !== undefined ? baselineCost - postCompactionTurnCost : undefined;

	return {
		strategy: "compact_and_continue",
		viable: tokensReclaimed > 0,
		...(postCompactionTurnCost !== undefined ? { costPerTurnUsd: round(postCompactionTurnCost, 6) } : {}),
		...(savings !== undefined ? { savingsPerTurnUsd: round(savings, 6) } : {}),
		notes: summarizer
			? `Summarize older turns down to ~${targetTokens} tokens using ${summarizer.id}; reclaims ${tokensReclaimed} tokens.`
			: `Summarize older turns down to ~${targetTokens} tokens; reclaims ${tokensReclaimed} tokens. No cheap summarizer in candidate set.`,
		details: {
			targetTokens,
			tokensReclaimed,
			summarizerModelId: summarizer?.id,
			summarizationCostUsd: summarizationCost !== undefined ? round(summarizationCost, 6) : undefined,
		},
	};
}

function buildSwitchModelOption(
	currentModel: ModelCard,
	currentTokens: number,
	expectedOutputTokens: number,
	baselineCost: number | undefined,
	candidateAlternatives: ModelCard[],
): StrategyOption {
	const candidates = candidateAlternatives
		.filter((m) => m.id !== currentModel.id && m.contextWindow >= currentTokens && m.pricing?.inputPerMillion !== undefined)
		.map((m) => ({
			model: m,
			cost: perTurnCost(m.pricing, currentTokens, expectedOutputTokens, false) ?? Number.POSITIVE_INFINITY,
		}))
		.sort((a, b) => a.cost - b.cost)
		.slice(0, 3);

	if (candidates.length === 0) {
		return {
			strategy: "switch_model",
			viable: false,
			notes: "No alternative model in the candidate set fits the current context size.",
		};
	}

	const best = candidates[0];
	const savings = baselineCost !== undefined ? baselineCost - best.cost : undefined;

	return {
		strategy: "switch_model",
		viable: true,
		costPerTurnUsd: round(best.cost, 6),
		...(savings !== undefined ? { savingsPerTurnUsd: round(savings, 6) } : {}),
		notes: `Cheapest fit: ${best.model.id} (${best.model.contextWindow} context). ${candidates.length - 1} other option(s) considered.`,
		details: {
			alternatives: candidates.map((c) => ({
				id: c.model.id,
				provider: c.model.provider,
				contextWindow: c.model.contextWindow,
				costPerTurnUsd: Number.isFinite(c.cost) ? round(c.cost, 6) : null,
			})),
		},
	};
}

function buildBatchOffloadOption(
	model: ModelCard,
	currentTokens: number,
	expectedOutputTokens: number,
	baselineCost: number | undefined,
): StrategyOption {
	const batchIn = model.pricing?.batchInputPerMillion;
	const batchOut = model.pricing?.batchOutputPerMillion;
	if (batchIn === undefined || batchOut === undefined) {
		return {
			strategy: "batch_offload",
			viable: false,
			notes: "Model does not publish Batch API pricing.",
		};
	}

	const batchCost = (currentTokens * batchIn + expectedOutputTokens * batchOut) / 1_000_000;
	const savings = baselineCost !== undefined ? baselineCost - batchCost : undefined;
	return {
		strategy: "batch_offload",
		viable: true,
		costPerTurnUsd: round(batchCost, 6),
		...(savings !== undefined ? { savingsPerTurnUsd: round(savings, 6) } : {}),
		notes: "Batch API trades latency (typically 24h SLO) for cheaper tokens — only viable if the workload is not real-time.",
		details: { batchInputPerMillion: batchIn, batchOutputPerMillion: batchOut },
	};
}

function pickRecommended(options: StrategyOption[], situation: ContextSituation): StrategyOption["strategy"] {
	const viable = options.filter((o) => o.viable);
	if (viable.length === 0) return "continue";

	if (situation.headroomPercent < HEADROOM_CRITICAL_PERCENT) {
		const compact = viable.find((o) => o.strategy === "compact_and_continue");
		if (compact) return "compact_and_continue";
		const switchModel = viable.find((o) => o.strategy === "switch_model");
		if (switchModel) return "switch_model";
	}

	const withSavings = viable
		.filter((o) => o.strategy !== "continue" && typeof o.savingsPerTurnUsd === "number" && o.savingsPerTurnUsd! > 0)
		.sort((a, b) => (b.savingsPerTurnUsd ?? 0) - (a.savingsPerTurnUsd ?? 0));
	if (withSavings.length > 0) return withSavings[0].strategy;

	return "continue";
}

function pickCheapestChatModel(candidates: ModelCard[], currentModel: ModelCard): ModelCard | undefined {
	return candidates
		.filter(
			(m) =>
				m.id !== currentModel.id &&
				m.mode === "chat" &&
				typeof m.pricing?.inputPerMillion === "number" &&
				typeof m.pricing?.outputPerMillion === "number",
		)
		.sort((a, b) => (a.pricing?.inputPerMillion ?? 0) - (b.pricing?.inputPerMillion ?? 0))[0];
}

function perTurnCost(
	pricing: ModelPricing | undefined,
	inputTokens: number,
	outputTokens: number,
	useLongContextTier: boolean,
): number | undefined {
	if (!pricing) return undefined;
	const inputRate = useLongContextTier
		? (pricing.longContextInputPerMillion ?? pricing.inputPerMillion)
		: pricing.inputPerMillion;
	const outputRate = useLongContextTier
		? (pricing.longContextOutputPerMillion ?? pricing.outputPerMillion)
		: pricing.outputPerMillion;
	if (inputRate === undefined || outputRate === undefined) return undefined;
	return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

function round(n: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(n * factor) / factor;
}
