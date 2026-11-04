/**
 * kosha-discovery — Providers known only from the public catalog.
 *
 * models.dev lists far more providers than kosha has discoverers for. Each slug
 * nothing else claims is saved here, so a new one appears with no code change.
 * These rows answer "what does this named provider charge" and nothing else:
 * they go in their own file, never in the registry or the provider cache, and
 * they can't be routed to. The only network use is the catalog fetch the other
 * providers already share.
 * @module
 */

import type { DiscoveryModelV1 } from "../discovery-contract.js";
import { normalizeProviderId } from "../provider-catalog.js";
import { loadModelsDevCatalog } from "./modelsdev-catalog.js";
import { getCatalogOnlySeed, mappedModelsDevSlugs } from "./modelsdev-seed.js";

/** The slug becomes a provider id in a stored key. */
const SAFE_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One row per model of each catalog slug not claimed by a mapped provider, a
 * built-in discoverer in `claimedIds`, or a provider alias. Only what a reader
 * needs: this file holds three times the rows of the registry.
 */
export async function buildCatalogOnlyRows(claimedIds: Iterable<string>): Promise<DiscoveryModelV1[]> {
	const catalog = await loadModelsDevCatalog();
	const claimed = new Set([...claimedIds, ...mappedModelsDevSlugs()]);
	const rows: DiscoveryModelV1[] = [];
	for (const [slug, provider] of Object.entries(catalog)) {
		if (claimed.has(slug) || normalizeProviderId(slug) !== slug) continue;
		if (!SAFE_SLUG_PATTERN.test(slug) || !provider.models || typeof provider.models !== "object") continue;
		for (const card of await getCatalogOnlySeed(slug)) {
			rows.push({
				key: `${slug}:${card.id}`,
				modelId: card.id,
				name: card.name,
				providerId: slug,
				canonicalProviderId: "models.dev",
				mode: card.mode,
				capabilities: card.capabilities,
				rawCapabilities: card.rawCapabilities ?? [],
				pricing: card.pricing ?? null,
				discoveredAt: card.discoveredAt,
				source: "models.dev",
			} as unknown as DiscoveryModelV1);
		}
	}
	return rows.sort((a, b) => a.key.localeCompare(b.key));
}
