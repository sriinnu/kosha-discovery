/**
 * kosha-discovery — Public promotional pricing overrides.
 *
 * Hand-curated list of known active promotional discounts that the public
 * catalogs (models.dev, LiteLLM) have not yet picked up. Each entry has a
 * hard expiry date and is automatically ignored once `Date.now() > endsAt`,
 * so this file does not need cleanup after a promo ends — stale entries
 * become no-ops.
 *
 * This is a deliberate, narrow seam. The default discovery flow stays
 * keyless-first via the public catalogs; overrides only step in when a
 * provider has publicly announced a discount that the upstream catalogs
 * are slower to reflect.
 *
 * Adding an entry:
 *   1. Confirm the promo is publicly announced on the provider's site.
 *   2. Find the canonical model id used in kosha (e.g. `deepseek-v4-pro`).
 *   3. Add an entry below with the explicit end timestamp.
 *   4. Cite the source URL in `reason` so a future reader can verify it.
 *
 * Removing or letting an entry expire requires no action — the override
 * silently goes inert once the clock passes `endsAt`.
 * @module
 */

import type { ModelCard, ModelPricing } from "../types.js";

/**
 * A single promotional override. Matches by `(providerId, modelId)` and
 * applies the given pricing when `Date.now() < endsAt.getTime()`.
 */
export interface PromoOverride {
	/** kosha provider id (e.g. "deepseek"). */
	providerId: string;
	/** Exact model id as it appears in kosha (e.g. "deepseek-v4-pro"). */
	modelId: string;
	/** Replacement pricing applied while the promo is active. */
	pricing: ModelPricing;
	/** Hard expiry. The override has no effect once this passes. */
	endsAt: Date;
	/** Free-form note for humans — should cite the source URL. */
	reason: string;
}

/**
 * Built-in promo overrides. Keep small and well-cited.
 */
export const PROMO_OVERRIDES: readonly PromoOverride[] = [
	{
		providerId: "deepseek",
		modelId: "deepseek-v4-pro",
		// 75% off the standard $1.74/$3.48 input/output rates.
		// Cache hit also discounted 75% from $0.0145/M to $0.003625/M.
		pricing: {
			inputPerMillion: 0.435,
			outputPerMillion: 0.87,
			cacheReadPerMillion: 0.003625,
		},
		endsAt: new Date("2026-05-31T15:59:00Z"),
		reason:
			"DeepSeek 75% off promo on deepseek-v4-pro, extended to 2026-05-31 — https://api-docs.deepseek.com/quick_start/pricing/",
	},
];

/**
 * Apply any active promo overrides to the given cards in place. Returns the
 * same array (with patched cards) so callers can chain. Cards without a
 * matching active override are unchanged.
 *
 * Idempotent — re-running on already-overridden cards yields the same result.
 */
export function applyPromoOverrides(cards: ModelCard[], now: Date = new Date()): ModelCard[] {
	if (cards.length === 0) return cards;
	const active = PROMO_OVERRIDES.filter((promo) => promo.endsAt.getTime() > now.getTime());
	if (active.length === 0) return cards;

	for (let i = 0; i < cards.length; i += 1) {
		const card = cards[i];
		const match = active.find(
			(promo) => promo.providerId === card.provider && promo.modelId === card.id,
		);
		if (!match) continue;
		cards[i] = {
			...card,
			pricing: { ...card.pricing, ...match.pricing },
			// Preserve a record of why this row diverges from the public catalog
			// rate so consumers can trace the override.
			rawCapabilities: dedupe([...(card.rawCapabilities ?? card.capabilities), "promo_override"]),
		};
	}
	return cards;
}

function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}
