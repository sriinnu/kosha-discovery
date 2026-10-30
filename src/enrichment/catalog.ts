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

import { applyFreeTierFlag } from "../discovery/free-tier.js";
import type { SnapshotCatalog } from "../discovery/snapshot-catalog.js";
import type { Enricher, ModelCard, ModelPricing } from "../types.js";

export class CatalogEnricher implements Enricher {
	constructor(private readonly catalog: SnapshotCatalog) {}

	async enrich(models: ModelCard[]): Promise<ModelCard[]> {
		return models.map((model) => applyFreeTierFlag(this.enrichOne(model)));
	}

	private enrichOne(model: ModelCard): ModelCard {
		const entry = this.catalog.providers.get(model.provider)?.find((card) => card.id === model.id);
		if (!entry) return { ...model };

		const enriched: ModelCard = { ...model };
		if (entry.pricing) enriched.pricing = fillPricing(enriched.pricing, entry.pricing);
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
		"cacheReadPerMillion",
		"cacheWritePerMillion",
		"batchInputPerMillion",
		"batchOutputPerMillion",
	] as const) {
		if (filled[key] === undefined && entry[key] !== undefined) filled[key] = entry[key];
	}
	return filled;
}
