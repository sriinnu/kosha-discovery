/**
 * kosha-discovery — Direct provider pricing fallback enricher.
 *
 * When public aggregator catalogs (models.dev, LiteLLM) lack pricing for a
 * model (or lack a provider's own price witness), pings the provider's
 * documented public machine-readable JSON `/models` endpoint directly.
 * Zero telemetry: only queries registered provider endpoints when models
 * for that provider are present and need pricing/verification.
 * @module
 */

import { resolveCatalogSource } from "../catalog-source.js";
import { KOSHA_USER_AGENT } from "../discovery/base.js";
import { extractDirectProviderPricing } from "../discovery/direct-pricing-parse.js";
import { applyFreeTierFlag, isPlanBilled } from "../discovery/free-tier.js";
import { evidenceFrom } from "../discovery/price-evidence.js";
import { normalizeProviderId } from "../provider-catalog.js";
import { assertCleanPayload } from "../security.js";
import type { Enricher, ModelCard, ModelPricing } from "../types.js";

const DIRECT_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface DirectPricingSource {
	readonly providerId: string;
	readonly url: string;
	readonly parseOptions: { perMillionInputOutput?: boolean; perTokenInputOutput?: boolean };
}

const DIRECT_PUBLIC_PRICING_SOURCES: readonly DirectPricingSource[] = [
	{
		providerId: "openrouter",
		url: "https://openrouter.ai/api/v1/models",
		parseOptions: {},
	},
	{
		providerId: "vercel",
		url: "https://ai-gateway.vercel.sh/v1/models",
		parseOptions: { perTokenInputOutput: true },
	},
];

interface CachedPricingMap {
	expiresAt: number;
	prices: Map<string, ModelPricing>;
}

const cachedByProvider = new Map<string, Promise<CachedPricingMap>>();

/** Clear cached direct provider pricing fetches (called by refresh/force discovery). */
export function resetDirectPricingCache(): void {
	cachedByProvider.clear();
}

async function fetchProviderPricingMap(source: DirectPricingSource): Promise<CachedPricingMap> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(source.url, {
			headers: { "user-agent": KOSHA_USER_AGENT, accept: "application/json" },
			signal: controller.signal,
			redirect: "error",
		});
		if (!res.ok) {
			return { expiresAt: Date.now() + 30_000, prices: new Map() };
		}
		const contentLength = res.headers.get("content-length");
		if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
			return { expiresAt: Date.now() + 30_000, prices: new Map() };
		}
		const text = await res.text();
		if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
			return { expiresAt: Date.now() + 30_000, prices: new Map() };
		}
		const parsed = JSON.parse(text) as { data?: unknown };
		assertCleanPayload(parsed, `direct-pricing:${source.providerId}`);
		const prices = new Map<string, ModelPricing>();
		const rows = Array.isArray(parsed?.data) ? parsed.data : [];
		for (const item of rows) {
			if (!item || typeof item !== "object") continue;
			const row = item as Record<string, unknown>;
			if (typeof row.id !== "string" || !row.id) continue;
			const pricing = extractDirectProviderPricing(row, source.parseOptions);
			if (pricing) prices.set(row.id, pricing);
		}
		return { expiresAt: Date.now() + DIRECT_CACHE_TTL_MS, prices };
	} catch {
		return { expiresAt: Date.now() + 10_000, prices: new Map() };
	} finally {
		clearTimeout(timer);
	}
}

async function loadDirectPrices(source: DirectPricingSource): Promise<Map<string, ModelPricing>> {
	const existing = cachedByProvider.get(source.providerId);
	if (existing) {
		const resolved = await existing;
		if (Date.now() < resolved.expiresAt) return resolved.prices;
		cachedByProvider.delete(source.providerId);
	}
	const pending = fetchProviderPricingMap(source).catch(() => ({
		expiresAt: Date.now() + 10_000,
		prices: new Map<string, ModelPricing>(),
	}));
	cachedByProvider.set(source.providerId, pending);
	return (await pending).prices;
}

function needsDirectPrice(card: ModelCard): boolean {
	if (isPlanBilled(card)) return false;
	if (!card.pricing) return true;
	return !card.priceEvidence?.some((entry) => entry.source === "provider-api");
}

/**
 * Fallback enricher that queries providers' own public `/models` JSON endpoints
 * directly when upstream aggregator catalogs leave models unpriced.
 */
export class DirectProviderPricingEnricher implements Enricher {
	async enrich(models: ModelCard[]): Promise<ModelCard[]> {
		if (resolveCatalogSource().mode !== "community") return models;

		const sourcesToQuery = DIRECT_PUBLIC_PRICING_SOURCES.filter((source) =>
			models.some(
				(card) => (normalizeProviderId(card.provider) ?? card.provider) === source.providerId && needsDirectPrice(card),
			),
		);
		if (sourcesToQuery.length === 0) return models;

		const loaded = await Promise.all(
			sourcesToQuery.map(async (source) => [source.providerId, await loadDirectPrices(source)] as const),
		);
		const byProvider = new Map(loaded);

		return models.map((card) => {
			if (isPlanBilled(card)) return card;
			const providerId = normalizeProviderId(card.provider) ?? card.provider;
			const table = byProvider.get(providerId);
			if (!table) return card;
			const directPricing = table.get(card.id);
			if (!directPricing) return card;

			const updated: ModelCard = card.pricing
				? { ...card }
				: {
						...card,
						pricing: directPricing,
						pricingSource: "provider-live",
					};
			const witness = evidenceFrom({ ...updated, pricing: directPricing }, "provider-api");
			if (witness) {
				const existing = (updated.priceEvidence ?? []).filter((e) => e.source !== "provider-api");
				updated.priceEvidence = [witness, ...existing];
			}
			return applyFreeTierFlag(updated);
		});
	}
}
