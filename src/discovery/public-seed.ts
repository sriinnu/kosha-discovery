/**
 * kosha-discovery — Merged public-catalog seed.
 *
 * Combines the models.dev and LiteLLM keyless catalogs into a single seed
 * per kosha provider. Priorities:
 *
 *  1. **models.dev = primary.** Fresher, structured `release_date`/`last_updated`
 *     metadata, tiered pricing, structured modalities. Most up-to-date for the
 *     models we actively track.
 *  2. **LiteLLM = filler.** Backfills providers and models that models.dev does
 *     not yet cover (e.g. moonshot-cn variants, niche bedrock entries).
 *
 * Merge rules per (providerId, modelId):
 *  - models.dev entry wins when it exists.
 *  - LiteLLM-only entries are added to the seed (filler behaviour).
 *  - When both exist, models.dev metadata is kept; LiteLLM is *not* used to
 *    overwrite individual fields. The post-discovery LiteLLM enricher still
 *    runs and can fill any genuinely missing fields downstream.
 *
 * Failures in either source are non-fatal: a network blip on one feed
 * silently degrades to the other so kosha never fails closed.
 * @module
 */

import type { ModelCard } from "../types.js";
import { getLiteLLMSeed } from "./litellm-seed.js";
import { getModelsDevSeed } from "./modelsdev-seed.js";
import { applyPromoOverrides } from "./promo-overrides.js";

/**
 * Return a merged, deduplicated array of seed {@link ModelCard}s for the
 * given kosha provider, sourced from both public catalogs.
 */
export async function getPublicSeed(providerId: string): Promise<ModelCard[]> {
	const [modelsDev, litellm] = await Promise.all([
		getModelsDevSeed(providerId).catch(() => [] as ModelCard[]),
		getLiteLLMSeed(providerId).catch(() => [] as ModelCard[]),
	]);

	if (modelsDev.length === 0 && litellm.length === 0) return [];

	// Index models.dev by id so duplicate ids from LiteLLM are dropped.
	const seen = new Set<string>(modelsDev.map((card) => card.id));
	const merged: ModelCard[] = [...modelsDev];
	for (const card of litellm) {
		if (seen.has(card.id)) continue;
		seen.add(card.id);
		merged.push(card);
	}

	// Final pass: apply any active promotional overrides for cases where the
	// public catalogs haven't yet picked up a publicly-announced discount.
	return applyPromoOverrides(merged);
}
