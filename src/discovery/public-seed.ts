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
 * silently degrades to the other so kosha never fails closed. When *both*
 * are unreachable, kosha's own weekly snapshot (`snapshot-latest` on the
 * releases page) stands in — at most a week old, and ours to keep publishing
 * if either community catalog ever stops.
 * @module
 */

import { extractOriginProvider } from "../normalize.js";
import type { ModelCard } from "../types.js";
import { getLiteLLMSeed } from "./litellm-seed.js";
import { getModelsDevSeed } from "./modelsdev-seed.js";
import { applyPromoOverrides } from "./promo-overrides.js";
import { getSnapshotSeed } from "./snapshot-catalog.js";

/**
 * Return a merged, deduplicated array of seed {@link ModelCard}s for the
 * given kosha provider, sourced from both public catalogs.
 */
export async function getPublicSeed(providerId: string): Promise<ModelCard[]> {
	const [modelsDevResult, litellmResult] = await Promise.allSettled([
		getModelsDevSeed(providerId),
		getLiteLLMSeed(providerId),
	]);
	const modelsDev = modelsDevResult.status === "fulfilled" ? modelsDevResult.value : [];
	const litellm = litellmResult.status === "fulfilled" ? litellmResult.value : [];

	// Nothing came back and at least one catalog was unreachable: fall back to
	// the published snapshot. Only "unreachable" counts — two catalogs that
	// loaded fine and simply do not list this provider is a legitimate empty
	// answer. One is enough because many providers are mapped in only one of
	// them (Bedrock and Vertex come from models.dev alone).
	const unreachable = modelsDevResult.status === "rejected" || litellmResult.status === "rejected";
	if (unreachable && modelsDev.length === 0 && litellm.length === 0) {
		try {
			return applyPromoOverrides(attributeCreators(await getSnapshotSeed(providerId), providerId));
		} catch {
			return [];
		}
	}

	if (modelsDev.length === 0 && litellm.length === 0) return [];

	// Index models.dev by id so duplicate ids from LiteLLM are dropped.
	const seen = new Set<string>(modelsDev.map((card) => card.id));
	const merged: ModelCard[] = [...modelsDev];
	for (const card of litellm) {
		if (seen.has(card.id)) continue;
		seen.add(card.id);
		merged.push(card);
	}

	// Both seeds stamp `originProvider` with the serving provider, which is
	// only true for a provider's own models. A reseller's row for
	// `claude-opus-5-5` was claiming the reseller built it — and so ranked as
	// a direct route next to Anthropic's. Recover the creator from the ID.
	// Final pass: apply any active promotional overrides for cases where the
	// public catalogs haven't yet picked up a publicly-announced discount.
	return applyPromoOverrides(attributeCreators(merged, providerId));
}

/** Replace a serving-provider `originProvider` with the creator the ID names. */
function attributeCreators(cards: ModelCard[], providerId: string): ModelCard[] {
	return cards.map((card) =>
		card.originProvider === providerId
			? { ...card, originProvider: extractOriginProvider(card.id) ?? providerId }
			: card,
	);
}
