/**
 * kosha-discovery — Direct provider `/v1/models` pricing extractor.
 *
 * Extracts unambiguous pricing fields when a provider's own `/models` or
 * `/v1/models` response carries them inline (Together per-1M `input`/`output`,
 * OpenRouter/Vercel per-token `prompt`/`completion` strings, or explicit
 * `*_per_million` / `*_cost_per_token` fields). Never fabricates missing rates.
 * @module
 */

import { sanitizePricing } from "../price-trust.js";
import type { ModelPricing } from "../types.js";

const PER_MILLION = 1_000_000;

export interface DirectPricingParseOptions {
	/**
	 * When true, bare numeric `pricing.input` / `pricing.output` are interpreted as
	 * USD per 1M tokens (Together AI format). Otherwise only unambiguous unit-named
	 * keys (`input_per_million`, `prompt`/`completion`, `input_cost_per_token`, etc.)
	 * or stringified per-token rates when `perTokenStrings` is true are read.
	 */
	perMillionInputOutput?: boolean;
	/** When true, `pricing.input` / `pricing.output` are USD per single token (Vercel format). */
	perTokenInputOutput?: boolean;
	/** When true, `pricing.request` and `pricing.web_search` are already per-1K requests (Vercel format). */
	perThousandRequests?: boolean;
}

function readNum(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		const parsed = Number(trimmed);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

/**
 * Extract pricing from an inline provider model payload (`{ pricing: ... }` or `{ model_spec: { pricing: ... } }`).
 * Returns `undefined` if no valid bidirectional token pricing can be read.
 */
export function extractDirectProviderPricing(
	raw: Record<string, unknown>,
	options: DirectPricingParseOptions = {},
): ModelPricing | undefined {
	const modelSpec =
		raw.model_spec && typeof raw.model_spec === "object" ? (raw.model_spec as Record<string, unknown>) : undefined;
	const pricingObj =
		raw.pricing && typeof raw.pricing === "object" && !Array.isArray(raw.pricing)
			? (raw.pricing as Record<string, unknown>)
			: modelSpec?.pricing && typeof modelSpec.pricing === "object" && !Array.isArray(modelSpec.pricing)
				? (modelSpec.pricing as Record<string, unknown>)
				: undefined;
	if (!pricingObj) return undefined;

	let inputPerMillion: number | undefined;
	let outputPerMillion: number | undefined;
	let cacheReadPerMillion: number | undefined;
	let cacheWritePerMillion: number | undefined;
	let batchInputPerMillion: number | undefined;
	let batchOutputPerMillion: number | undefined;
	let imageOutputPerImage: number | undefined;
	let requestPerThousand: number | undefined;
	let webSearchPerThousandRequests: number | undefined;
	let reasoningOutputPerMillion: number | undefined;
	let longContextInputPerMillion: number | undefined;
	let longContextOutputPerMillion: number | undefined;
	let longContextThresholdTokens: number | undefined;
	let videoOutputPerSecond: number | undefined;
	let videoInputPerMillion: number | undefined;
	let audioInputPerSecond: number | undefined;

	const firstTierPerToken = (tiers: unknown): number | undefined => {
		if (!Array.isArray(tiers) || tiers.length === 0) return undefined;
		const first = tiers[0] as { cost?: unknown } | undefined;
		return readNum(first?.cost);
	};
	const longTierEntry = (tiers: unknown): { min: number; perMillion: number } | undefined => {
		if (!Array.isArray(tiers)) return undefined;
		for (const item of tiers) {
			if (!item || typeof item !== "object") continue;
			const min = (item as { min?: unknown }).min;
			const cost = readNum((item as { cost?: unknown }).cost);
			if (typeof min === "number" && Number.isFinite(min) && min > 0 && cost !== undefined) {
				return { min, perMillion: cost * PER_MILLION };
			}
		}
		return undefined;
	};

	// 1) Explicit per-million fields.
	const explicitIn = readNum(pricingObj.inputPerMillion) ?? readNum(pricingObj.input_per_million);
	const explicitOut = readNum(pricingObj.outputPerMillion) ?? readNum(pricingObj.output_per_million);
	if (explicitIn !== undefined && explicitOut !== undefined) {
		inputPerMillion = explicitIn;
		outputPerMillion = explicitOut;
	}

	// 2) Unambiguous per-token OpenRouter/LiteLLM keys (including tiered Vercel fields).
	if (inputPerMillion === undefined || outputPerMillion === undefined) {
		const prompt = readNum(pricingObj.prompt);
		const completion = readNum(pricingObj.completion);
		if (prompt !== undefined && completion !== undefined) {
			inputPerMillion = prompt * PER_MILLION;
			outputPerMillion = completion * PER_MILLION;
		} else {
			const inTok = readNum(pricingObj.input_cost_per_token);
			const outTok = readNum(pricingObj.output_cost_per_token);
			if (inTok !== undefined && outTok !== undefined) {
				inputPerMillion = inTok * PER_MILLION;
				outputPerMillion = outTok * PER_MILLION;
			}
		}
	}

	// 3) Provider-specific `input`/`output` conventions and Vercel tiered fields.
	if (
		(inputPerMillion === undefined || outputPerMillion === undefined) &&
		(options.perMillionInputOutput || options.perTokenInputOutput)
	) {
		const inp = readNum(pricingObj.input) ?? firstTierPerToken(pricingObj.input_tiers);
		const out = readNum(pricingObj.output) ?? firstTierPerToken(pricingObj.output_tiers);
		if (inp !== undefined && out !== undefined) {
			const scale = options.perTokenInputOutput ? PER_MILLION : 1;
			inputPerMillion = inp * scale;
			outputPerMillion = out * scale;
		}
	}

	const crMillion = readNum(pricingObj.cacheReadPerMillion) ?? readNum(pricingObj.cache_read_per_million);
	const cwMillion = readNum(pricingObj.cacheWritePerMillion) ?? readNum(pricingObj.cache_write_per_million);
	const crTok =
		readNum(pricingObj.input_cache_read) ??
		readNum(pricingObj.cache_read_input_token_cost) ??
		firstTierPerToken(pricingObj.input_cache_read_tiers);
	const cwTok =
		readNum(pricingObj.input_cache_write) ??
		readNum(pricingObj.cache_creation_input_token_cost) ??
		firstTierPerToken(pricingObj.input_cache_write_tiers);

	if (crMillion !== undefined) cacheReadPerMillion = crMillion;
	else if (crTok !== undefined) cacheReadPerMillion = crTok * PER_MILLION;

	if (cwMillion !== undefined) cacheWritePerMillion = cwMillion;
	else if (cwTok !== undefined) cacheWritePerMillion = cwTok * PER_MILLION;

	const biMillion = readNum(pricingObj.batchInputPerMillion) ?? readNum(pricingObj.batch_input_per_million);
	const boMillion = readNum(pricingObj.batchOutputPerMillion) ?? readNum(pricingObj.batch_output_per_million);
	if (biMillion !== undefined) batchInputPerMillion = biMillion;
	if (boMillion !== undefined) batchOutputPerMillion = boMillion;

	const reasoningTok = readNum(pricingObj.internal_reasoning);
	if (reasoningTok !== undefined) reasoningOutputPerMillion = reasoningTok * PER_MILLION;

	const longIn = longTierEntry(pricingObj.input_tiers);
	const longOut = longTierEntry(pricingObj.output_tiers);
	if (longIn) longContextInputPerMillion = longIn.perMillion;
	if (longOut) longContextOutputPerMillion = longOut.perMillion;
	const threshold = longIn?.min ?? longOut?.min;
	if (threshold !== undefined) longContextThresholdTokens = threshold;

	const imgFlat = readNum(pricingObj.image_output) ?? readNum(pricingObj.image);
	const imgDims = Array.isArray(pricingObj.image_dimension_quality_pricing)
		? pricingObj.image_dimension_quality_pricing
				.map((e) => (e && typeof e === "object" ? readNum((e as { cost?: unknown }).cost) : undefined))
				.filter((n): n is number => n !== undefined && n > 0)
		: [];
	const imgCandidates = [...(imgFlat !== undefined && imgFlat > 0 ? [imgFlat] : []), ...imgDims];
	if (imgCandidates.length > 0) imageOutputPerImage = Math.min(...imgCandidates);

	const vidSec = readNum(pricingObj.video_output_per_second);
	if (vidSec !== undefined && vidSec > 0) videoOutputPerSecond = vidSec;
	const vidInTok = readNum(pricingObj.video_input);
	if (vidInTok !== undefined && vidInTok > 0) videoInputPerMillion = vidInTok * PER_MILLION;
	const audSec = readNum(pricingObj.audio_input_per_second);
	if (audSec !== undefined && audSec > 0) audioInputPerSecond = audSec;

	const req = readNum(pricingObj.request);
	if (req !== undefined && req > 0) {
		requestPerThousand = options.perThousandRequests ? req : req * 1_000;
	}
	const webSearch = readNum(pricingObj.web_search);
	if (webSearch !== undefined && webSearch > 0) {
		webSearchPerThousandRequests = options.perThousandRequests ? webSearch : webSearch * 1_000;
	}

	const hasAnyUnitRate =
		imageOutputPerImage !== undefined ||
		requestPerThousand !== undefined ||
		webSearchPerThousandRequests !== undefined ||
		videoOutputPerSecond !== undefined ||
		videoInputPerMillion !== undefined ||
		audioInputPerSecond !== undefined;
	if ((inputPerMillion === undefined || outputPerMillion === undefined) && !hasAnyUnitRate) {
		return undefined;
	}

	return sanitizePricing({
		inputPerMillion: inputPerMillion ?? 0,
		outputPerMillion: outputPerMillion ?? 0,
		...(reasoningOutputPerMillion !== undefined ? { reasoningOutputPerMillion } : {}),
		...(cacheReadPerMillion !== undefined ? { cacheReadPerMillion } : {}),
		...(cacheWritePerMillion !== undefined ? { cacheWritePerMillion } : {}),
		...(batchInputPerMillion !== undefined ? { batchInputPerMillion } : {}),
		...(batchOutputPerMillion !== undefined ? { batchOutputPerMillion } : {}),
		...(longContextInputPerMillion !== undefined ? { longContextInputPerMillion } : {}),
		...(longContextOutputPerMillion !== undefined ? { longContextOutputPerMillion } : {}),
		...(longContextThresholdTokens !== undefined ? { longContextThresholdTokens } : {}),
		...(imageOutputPerImage !== undefined ? { imageOutputPerImage } : {}),
		...(videoOutputPerSecond !== undefined ? { videoOutputPerSecond } : {}),
		...(videoInputPerMillion !== undefined ? { videoInputPerMillion } : {}),
		...(audioInputPerSecond !== undefined ? { audioInputPerSecond } : {}),
		...(requestPerThousand !== undefined ? { requestPerThousand } : {}),
		...(webSearchPerThousandRequests !== undefined ? { webSearchPerThousandRequests } : {}),
	});
}
