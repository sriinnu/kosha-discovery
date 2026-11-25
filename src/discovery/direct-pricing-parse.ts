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

	// 1) Explicit per-million fields.
	const explicitIn = readNum(pricingObj.inputPerMillion) ?? readNum(pricingObj.input_per_million);
	const explicitOut = readNum(pricingObj.outputPerMillion) ?? readNum(pricingObj.output_per_million);
	if (explicitIn !== undefined && explicitOut !== undefined) {
		inputPerMillion = explicitIn;
		outputPerMillion = explicitOut;
	}

	// 2) Unambiguous per-token OpenRouter/LiteLLM keys.
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

	// 3) Provider-specific `input`/`output` conventions.
	if (
		(inputPerMillion === undefined || outputPerMillion === undefined) &&
		(options.perMillionInputOutput || options.perTokenInputOutput)
	) {
		const inp = readNum(pricingObj.input);
		const out = readNum(pricingObj.output);
		if (inp !== undefined && out !== undefined) {
			const scale = options.perTokenInputOutput ? PER_MILLION : 1;
			inputPerMillion = inp * scale;
			outputPerMillion = out * scale;
		}
	}

	if (inputPerMillion === undefined || outputPerMillion === undefined) {
		return undefined;
	}

	const crMillion = readNum(pricingObj.cacheReadPerMillion) ?? readNum(pricingObj.cache_read_per_million);
	const cwMillion = readNum(pricingObj.cacheWritePerMillion) ?? readNum(pricingObj.cache_write_per_million);
	const crTok = readNum(pricingObj.input_cache_read) ?? readNum(pricingObj.cache_read_input_token_cost);
	const cwTok = readNum(pricingObj.input_cache_write) ?? readNum(pricingObj.cache_creation_input_token_cost);

	if (crMillion !== undefined) cacheReadPerMillion = crMillion;
	else if (crTok !== undefined) cacheReadPerMillion = crTok * PER_MILLION;

	if (cwMillion !== undefined) cacheWritePerMillion = cwMillion;
	else if (cwTok !== undefined) cacheWritePerMillion = cwTok * PER_MILLION;

	const biMillion = readNum(pricingObj.batchInputPerMillion) ?? readNum(pricingObj.batch_input_per_million);
	const boMillion = readNum(pricingObj.batchOutputPerMillion) ?? readNum(pricingObj.batch_output_per_million);
	if (biMillion !== undefined) batchInputPerMillion = biMillion;
	if (boMillion !== undefined) batchOutputPerMillion = boMillion;

	const img = readNum(pricingObj.image);
	if (img !== undefined && img > 0) imageOutputPerImage = img;
	const req = readNum(pricingObj.request);
	if (req !== undefined && req > 0) requestPerThousand = req * 1_000;

	return sanitizePricing({
		inputPerMillion,
		outputPerMillion,
		...(cacheReadPerMillion !== undefined ? { cacheReadPerMillion } : {}),
		...(cacheWritePerMillion !== undefined ? { cacheWritePerMillion } : {}),
		...(batchInputPerMillion !== undefined ? { batchInputPerMillion } : {}),
		...(batchOutputPerMillion !== undefined ? { batchOutputPerMillion } : {}),
		...(imageOutputPerImage !== undefined ? { imageOutputPerImage } : {}),
		...(requestPerThousand !== undefined ? { requestPerThousand } : {}),
	});
}
