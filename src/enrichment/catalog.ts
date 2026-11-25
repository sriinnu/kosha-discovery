/**
 * kosha-discovery — Enrichment from kosha's own catalog.
 *
 * In `pinned` and `local` mode the LiteLLM enricher is off, so models found
 * with a key would lose the prices and limits it used to fill. This fills
 * the same gaps from the active catalog instead (the published snapshot or
 * the local file), matched by provider and model id. Like the LiteLLM
 * enricher it only fills what is missing and never overwrites API data.
 * @module
 */

import { applyFreeTierFlag, isPlanBilled } from "../discovery/free-tier.js";
import type { SnapshotCatalog } from "../discovery/snapshot-catalog.js";
import type { Enricher, ModelCard, ModelPricing } from "../types.js";

export class CatalogEnricher implements Enricher {
	private readonly byProvider = new Map<string, Map<string, ModelCard>>();

	constructor(catalog: SnapshotCatalog) {
		for (const [provider, cards] of catalog.providers) {
			this.byProvider.set(provider, new Map(cards.map((card) => [card.id, card])));
		}
	}

	async enrich(models: ModelCard[]): Promise<ModelCard[]> {
		return models.map((model) => applyFreeTierFlag(this.enrichOne(model)));
	}

	private enrichOne(model: ModelCard): ModelCard {
		const entry = this.byProvider.get(model.provider)?.get(model.id);
		if (!entry) return { ...model };

		const enriched: ModelCard = { ...model };
		if (entry.pricing && !isPlanBilled(enriched)) enriched.pricing = fillPricing(enriched.pricing, entry.pricing);
		if (!enriched.originPricing && entry.originPricing) enriched.originPricing = entry.originPricing;
		if (enriched.contextWindow === 0 && entry.contextWindow) enriched.contextWindow = entry.contextWindow;
		if (enriched.maxOutputTokens === 0 && entry.maxOutputTokens) enriched.maxOutputTokens = entry.maxOutputTokens;
		if (enriched.maxInputTokens === undefined && entry.maxInputTokens) enriched.maxInputTokens = entry.maxInputTokens;
		if (enriched.dimensions === undefined && entry.dimensions) enriched.dimensions = entry.dimensions;
		if (enriched.status === undefined && entry.status) enriched.status = entry.status;
		if (enriched.releaseDate === undefined && entry.releaseDate) enriched.releaseDate = entry.releaseDate;
		return enriched;
	}
}

/** Take the catalog's pricing when there is none; otherwise top up missing rates only. */
function fillPricing(current: ModelPricing | undefined, entry: ModelPricing): ModelPricing {
	if (!current) return entry;
	const filled: ModelPricing = { ...current };
	for (const key of [
		"reasoningInputPerMillion",
		"reasoningOutputPerMillion",
		"cacheReadPerMillion",
		"cacheWritePerMillion",
		"cacheWrite1hPerMillion",
		"cacheStoragePerMillionPerHour",
		"batchInputPerMillion",
		"batchOutputPerMillion",
		"longContextInputPerMillion",
		"longContextOutputPerMillion",
		"longContextThresholdTokens",
		"imageInputPerImage",
		"imageOutputPerImage",
		"audioInputPerMillion",
		"audioOutputPerMillion",
		"audioInputPerSecond",
		"audioOutputPerSecond",
		"videoInputPerSecond",
		"videoOutputPerSecond",
		"videoInputPerMillion",
		"inputPerMillionCharacters",
		"outputPerMillionCharacters",
		"citation",
	] as const) {
		if (filled[key] === undefined && entry[key] !== undefined) {
			(filled as unknown as Record<string, unknown>)[key] = entry[key];
		}
	}
	if (!filled.cacheWrites?.length && entry.cacheWrites?.length) filled.cacheWrites = entry.cacheWrites;
	if (!filled.bands?.length && entry.bands?.length) filled.bands = entry.bands;
	return filled;
}
