/**
 * kosha-discovery — The price gate on the published weekly snapshot.
 *
 * A local install holds a suspect price move in its own manifest, but the
 * weekly snapshot is the seed for `pinned` users, for the catalog-outage
 * fallback and for a first run with no manifest yet. Published raw, one bad
 * catalog week would reach them unchecked. So the snapshot goes through the
 * same merge as the local manifest, judged against the snapshot published
 * before it: a suspect move is published at the previous price, tagged
 * `pricing_quarantined`, and carries its hold forward to the next week.
 *
 * Runs weekly, so every hold window (1–7 days) has passed by the next run:
 * a real cut reaches snapshot users a week late. A collapse to $0 or under 1%
 * is never released by waiting; only an explicit accept releases it.
 * @module
 */

import type { CatalogEnvelope } from "./catalog-source.js";
import type { PriceEvidence } from "./discovery/price-evidence.js";
import type { DiscoverySnapshotV1 } from "./discovery-contract.js";
import { DISCOVERY_SCHEMA_VERSION } from "./discovery-contract.js";
import { sanitizeModelPricing } from "./price-trust.js";
import { highestRates, mergeManifests } from "./registry-runtime.js";
import type { ModelCard, ModelPricing, ProviderInfo } from "./types.js";

/** A price the gate kept at its previous value this run. */
export interface HeldSnapshotPrice {
	providerId: string;
	modelId: string;
	/** The price published (the previous one). */
	published: { inputPerMillion?: number; outputPerMillion?: number } | null;
	/** The price the catalogs reported this run. */
	reported: { inputPerMillion?: number; outputPerMillion?: number } | null;
	/** When the reported price was first seen (epoch ms). */
	since: number;
}

export interface SnapshotGateResult {
	envelope: CatalogEnvelope;
	held: HeldSnapshotPrice[];
}

const keyOf = (providerId: string, modelId: string) => `${providerId}\0${modelId}`;

/** Flatten an envelope into merge rows, keyed by provider and model id. */
function toSnapshot(envelope: CatalogEnvelope): DiscoverySnapshotV1 {
	const models = [];
	for (const provider of envelope.providers ?? []) {
		for (const card of provider.models ?? []) {
			if (!card || typeof card.id !== "string") continue;
			models.push({ ...card, key: keyOf(provider.id, card.id), providerId: provider.id, modelId: card.id });
		}
	}
	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		discoveredAt: envelope.discoveredAt,
		models,
		providers: [],
	} as unknown as DiscoverySnapshotV1;
}

function headline(pricing: unknown): HeldSnapshotPrice["published"] {
	if (!pricing || typeof pricing !== "object") return null;
	const p = pricing as { inputPerMillion?: number; outputPerMillion?: number };
	return { inputPerMillion: p.inputPerMillion, outputPerMillion: p.outputPerMillion };
}

/**
 * Gate a fresh snapshot against the one published before it. With no
 * previous snapshot every price is taken and becomes the anchor.
 *
 * `accept` lists `provider/model` refs whose current hold a maintainer has
 * checked and released, the snapshot's `kosha registry accept`.
 */
export function gateSnapshot(
	previous: CatalogEnvelope | null,
	fresh: CatalogEnvelope,
	accept: readonly string[] = [],
): SnapshotGateResult {
	const accepted = new Set(
		accept.map((ref) => {
			const slash = ref.indexOf("/");
			return slash > 0 ? keyOf(ref.slice(0, slash), ref.slice(slash + 1)) : "";
		}),
	);
	let prior = previous ? toSnapshot(previous) : null;
	if (prior && accepted.size > 0) {
		prior = {
			...prior,
			models: prior.models.map((row) => {
				const hold = (row as { pricingHold?: object }).pricingHold;
				return hold && accepted.has(row.key) ? { ...row, pricingHold: { ...hold, accepted: true } } : row;
			}),
		};
	}
	const reported = new Map(toSnapshot(fresh).models.map((row) => [row.key, row.pricing]));
	const merged = mergeManifests(prior, toSnapshot(fresh));

	// Regroup by provider: fresh providers first, in their order, then any the
	// fresh run lost whose rows the merge still keeps.
	const shells = new Map<string, ProviderInfo>();
	for (const provider of [...(fresh.providers ?? []), ...(previous?.providers ?? [])]) {
		if (!shells.has(provider.id)) shells.set(provider.id, { ...provider, models: [] });
	}
	const held: HeldSnapshotPrice[] = [];
	for (const row of merged.models) {
		const shell = shells.get(row.providerId);
		if (!shell) continue;
		const { key: _key, providerId, modelId, ...rest } = row as typeof row & Record<string, unknown>;
		let card = rest as unknown as ModelCard;
		const tags = row.rawCapabilities ?? [];
		const quarantined = tags.includes("pricing_quarantined");
		const freshPricing = reported.get(row.key) ?? null;
		if ((quarantined || tags.includes("pricing_sources_disagree")) && card.pricing) {
			// As in a local install (applyManifestHolds): a held or disputed row
			// is published at the highest rate anyone reported, so only a cut
			// waits. Publishing a held rise at the old price would undercount.
			const evidence = (card as { priceEvidence?: PriceEvidence[] }).priceEvidence ?? [];
			const pricing = sanitizeModelPricing({
				...card,
				pricing: highestRates(card.pricing, freshPricing as ModelPricing | null, evidence),
			}).pricing;
			card = { ...card, pricing };
		}
		shell.models.push(card);
		const hold = (row as { pricingHold?: { since: number } }).pricingHold;
		if (hold && quarantined && freshPricing && JSON.stringify(card.pricing ?? null) !== JSON.stringify(freshPricing)) {
			held.push({
				providerId,
				modelId,
				published: headline(card.pricing),
				reported: headline(freshPricing),
				since: hold.since,
			});
		}
	}
	// A provider the fresh run returned stays even when empty (local runtimes
	// are, in CI); one only the previous snapshot had stays while it has rows.
	const freshIds = new Set((fresh.providers ?? []).map((p) => p.id));
	const providers = [...shells.values()].filter((p) => freshIds.has(p.id) || p.models.length > 0);
	return {
		envelope: {
			...fresh,
			providers,
			providerCount: providers.length,
			modelCount: providers.reduce((sum, p) => sum + p.models.length, 0),
		},
		held,
	};
}
