/**
 * kosha-discovery — Free-tier capability flag.
 *
 * Centralised helper that adds the `"free_tier"` capability to a
 * {@link ModelCard} when the model is genuinely free for both input and
 * output usage. Used by the public-catalog seeds (models.dev, LiteLLM)
 * and by the post-discovery enricher so any path that ends up with
 * 0/0 pricing gets the flag consistently.
 *
 * Distinct from "pricing unknown":
 *  - `pricing === undefined` → upstream had no pricing field at all.
 *  - `pricing = { in: 0, out: 0 }` → upstream said the model is free.
 *
 * Free can mean a structural offering (NVIDIA NIM dev tier, open-weights
 * via deepinfra) or a temporary promotion (DeepSeek off-peak windows).
 * We don't distinguish those today because no upstream catalog labels
 * them — but the flag is enough for downstream cost classification.
 * @module
 */

import type { ModelCard } from "../types.js";

export const FREE_TIER_CAPABILITY = "free_tier";

/**
 * Returns a copy of the card with `"free_tier"` added to capabilities
 * when both input and output pricing are exactly zero. No-op otherwise.
 *
 * Idempotent: calling it twice does not duplicate the flag.
 */
export function applyFreeTierFlag(card: ModelCard): ModelCard {
	if (!isFreeTier(card)) return card;
	if (card.capabilities.includes(FREE_TIER_CAPABILITY)) return card;
	const capabilities = [...card.capabilities, FREE_TIER_CAPABILITY];
	const rawCapabilities = card.rawCapabilities
		? card.rawCapabilities.includes(FREE_TIER_CAPABILITY)
			? card.rawCapabilities
			: [...card.rawCapabilities, FREE_TIER_CAPABILITY]
		: undefined;
	return { ...card, capabilities, rawCapabilities };
}

/** True when the card explicitly priced both directions at zero. */
export function isFreeTier(card: ModelCard): boolean {
	const pricing = card.pricing;
	if (!pricing) return false;
	return pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0;
}
