/**
 * kosha-discovery — Which prices kosha can trust.
 *
 * Most prices come from community catalogs. A $0 token price there is either
 * a genuinely free model or a mistake (or a poisoned entry), and nothing in
 * the card tells the two apart. The proxy, which costs chat by tokens,
 * refuses such a route under a budget, and every ranking puts a $0 score
 * built on it after the priced ones, so it can never come out "cheapest".
 * @module
 */

import { getProviderDescriptor } from "./provider-catalog.js";
import type { ModelCard } from "./types.js";

/**
 * True when input and output tokens are both $0 and nothing other than a
 * catalog vouches for it. Two exceptions are real $0: local runtimes (you run
 * them), and OpenRouter `:free` ids (the provider bills by id, so a `:free`
 * route costs nothing whatever the catalog says).
 *
 * A provider's own API doesn't vouch for $0 either: some adapters fill a
 * token rate the API left out with 0 (Vercel's does), so a live $0 can be
 * an unknown too.
 *
 * Only token rates count. The proxy estimates and records chat spend from
 * them alone, so an image or cache rate beside $0 tokens (a cache rate like
 * that was seen live on gemini-exp-1206) would still pass a budget as free.
 * Rankings judge per-image or per-second models by the score for the
 * query instead (see registryCheapestModels).
 */
export function isUnverifiedZeroPrice(model: ModelCard): boolean {
	const pricing = model.pricing;
	if (pricing?.inputPerMillion !== 0 || pricing.outputPerMillion !== 0) return false;
	if (model.provider === "openrouter" && model.id.endsWith(":free")) return false;
	return getProviderDescriptor(model.provider)?.isLocal !== true;
}

export const PRICE_RATE_FIELDS = [
	"inputPerMillion",
	"outputPerMillion",
	"reasoningInputPerMillion",
	"reasoningOutputPerMillion",
	"cacheReadPerMillion",
	"cacheWritePerMillion",
	"cacheWrite1hPerMillion",
	"batchInputPerMillion",
	"batchOutputPerMillion",
	"imageInputPerImage",
	"imageOutputPerImage",
	"audioInputPerMillion",
	"audioOutputPerMillion",
	"audioInputPerSecond",
	"audioOutputPerSecond",
	"videoInputPerSecond",
	"videoOutputPerSecond",
	"videoInputPerMillion",
	"webSearchPerThousandRequests",
	"mapsSearchPerThousandRequests",
	"requestPerThousand",
	"inputPerMillionCharacters",
	"outputPerMillionCharacters",
	"longContextInputPerMillion",
	"longContextOutputPerMillion",
	"longContextThresholdTokens",
] as const;

function isSaneRate(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Drop rates no catalog can mean: negative, NaN or infinite. A negative rate
 * would rank first in `cheapest` and write a negative ledger row that erases
 * the month's budget. If the input or output token rate is bad, the whole
 * block goes (the model becomes "unpriced", which every consumer already
 * treats as unknown, never free); a bad optional rate is just removed.
 * Returns the same object when nothing changed.
 */
export function sanitizePricing<P extends Record<string, unknown> | undefined | null>(pricing: P): P | undefined {
	if (!pricing) return pricing ?? undefined;
	if (!isSaneRate(pricing.inputPerMillion) || !isSaneRate(pricing.outputPerMillion)) return undefined;
	let out: Record<string, unknown> | null = null;
	for (const field of PRICE_RATE_FIELDS) {
		if (!(field in pricing) || pricing[field] === undefined) continue;
		if (isSaneRate(pricing[field])) continue;
		out ??= { ...pricing };
		delete out[field];
	}
	return (out ?? pricing) as P;
}

/** {@link sanitizePricing} applied to a card's billed and origin prices. */
export function sanitizeModelPricing(model: ModelCard): ModelCard {
	const pricing = sanitizePricing(model.pricing as unknown as Record<string, unknown> | undefined);
	const originPricing = sanitizePricing(model.originPricing as unknown as Record<string, unknown> | undefined);
	if (pricing === (model.pricing as unknown) && originPricing === (model.originPricing as unknown)) return model;
	const next = { ...model } as ModelCard;
	if (pricing) next.pricing = pricing as unknown as ModelCard["pricing"];
	else delete next.pricing;
	if (originPricing) next.originPricing = originPricing as unknown as ModelCard["originPricing"];
	else delete next.originPricing;
	return next;
}
