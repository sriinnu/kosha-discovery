/**
 * kosha-discovery — Cache hydration, credential stamping, and curated pricing pass.
 *
 * Keeps raw discovered/enriched cards clean of transient manifest hold tags and
 * folds due dated price changes + curated tables on every cache hydration.
 * @module
 */

import { catalogCacheKey } from "./catalog-source.js";
import { applyCitedPrices, applyDueChanges } from "./discovery/cited-prices.js";
import { applyFreeTierFlag } from "./discovery/free-tier.js";
import { applyPriceSchedules } from "./discovery/price-schedules.js";
import { applyPromoOverrides } from "./discovery/promo-overrides.js";
import { sanitizeModelCacheRates, sanitizeModelPricing } from "./price-trust.js";
import {
	getProviderConfig,
	getProviderDescriptor,
	normalizeProviderId,
	resolveEnvCredential,
} from "./provider-catalog.js";
import type { DiscoveryDependencies, RegistryState } from "./registry-state.js";
import type { CredentialResult, ModelCard, ProviderInfo } from "./types.js";

export const DEFAULT_CACHE_TTL_MS = 86_400_000;
export const CACHE_KEY_PREFIX = "provider_";
export const CREDENTIAL_STAMPS_KEY = "credential_stamps";

/**
 * Dynamically load the credential resolver when available.
 */
export async function getRegistryCredentialResolver(): Promise<{
	resolve: (providerId: string, explicitKey?: string) => Promise<CredentialResult>;
} | null> {
	try {
		const { CredentialResolver } = await import("./credentials/index.js");
		return new CredentialResolver();
	} catch {
		return null;
	}
}

/**
 * Resolve a credential from config or environment without the credential module.
 */
export function fallbackRegistryCredential(providerId: string, explicitKey?: string): CredentialResult {
	const normalizedProviderId = normalizeProviderId(providerId) ?? providerId;
	if (explicitKey) {
		return { apiKey: explicitKey, source: "config" };
	}

	if (normalizedProviderId === "vercel") {
		const apiKey = process.env.AI_GATEWAY_API_KEY;
		if (apiKey) return { apiKey, source: "env" };
		const oidcToken = process.env.VERCEL_OIDC_TOKEN;
		if (oidcToken) return { accessToken: oidcToken, source: "env" };
	}

	const found = resolveEnvCredential(getProviderDescriptor(normalizedProviderId));
	return found
		? { apiKey: found.apiKey, source: "env", envVar: found.envVar, shared: found.shared }
		: { source: "none" };
}

/**
 * Every curated pricing pass, in order: catalog cache rates are sanity-checked,
 * then kosha's cited prices, promos and time-of-day schedules win, then due
 * dated changes are folded and the basic rate check runs on the result.
 * Idempotent, so a cached registry gets it again on load.
 */
export function applyCuratedPricing(models: ModelCard[], now: Date = new Date()): ModelCard[] {
	return applyDueChanges(
		applyPriceSchedules(applyPromoOverrides(applyCitedPrices(models.map(sanitizeModelCacheRates), now), now)),
		now,
	)
		.map(sanitizeModelPricing)
		.map(applyFreeTierFlag);
}

function withCuratedPricing(provider: ProviderInfo): ProviderInfo {
	return { ...provider, models: applyCuratedPricing(provider.models) };
}

/**
 * Load provider data from disk cache when it is still fresh.
 */
export async function loadRegistryFromCache(
	state: RegistryState,
	providerIds?: string[],
	stampFor?: (providerId: string) => Promise<string>,
): Promise<boolean> {
	const ttl = state.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const stamps = stampFor
		? (await state.cache.get<Record<string, string>>(catalogCacheKey(CREDENTIAL_STAMPS_KEY)))?.data
		: undefined;

	if (!providerIds || providerIds.length === 0) {
		const allEntry = await state.cache.get<ProviderInfo[]>(catalogCacheKey("providers_all"));
		if (!allEntry || state.cache.isExpired(allEntry.timestamp, ttl)) {
			return false;
		}
		if (
			stampFor &&
			!(await cacheCredentialsMatch(
				state,
				allEntry.data.map((provider) => provider.id),
				stamps,
				stampFor,
			))
		) {
			return false;
		}

		for (const provider of allEntry.data) {
			state.providerMap.set(provider.id, withCuratedPricing(provider));
		}
		state.discoveredAt = allEntry.timestamp;
		return true;
	}

	const entries: ProviderInfo[] = [];
	let oldestTimestamp = Number.POSITIVE_INFINITY;
	for (const providerId of providerIds) {
		const entry = await state.cache.get<ProviderInfo>(catalogCacheKey(`${CACHE_KEY_PREFIX}${providerId}`));
		if (!entry || state.cache.isExpired(entry.timestamp, ttl)) {
			return false;
		}
		if (entry.timestamp < oldestTimestamp) oldestTimestamp = entry.timestamp;
		entries.push(entry.data);
	}
	if (stampFor) {
		const scoped = stamps
			? Object.fromEntries(providerIds.filter((id) => id in stamps).map((id) => [id, stamps[id]]))
			: undefined;
		if (!(await cacheCredentialsMatch(state, providerIds, scoped, stampFor))) return false;
	}
	for (const entry of entries) state.providerMap.set(entry.id, withCuratedPricing(entry));

	state.discoveredAt = Number.isFinite(oldestTimestamp) ? oldestTimestamp : Date.now();
	return true;
}

/** What a credential looks like to the cache: its source and env var, never the key. */
export function credentialStamp(credential: CredentialResult): string {
	return credential.envVar ? `${credential.source}:${credential.envVar}` : credential.source;
}

/** The credential this process would discover `providerId` with. */
export async function resolveProviderCredential(
	state: RegistryState,
	dependencies: Pick<DiscoveryDependencies, "resolveCredential" | "fallbackCredential">,
	providerId: string,
): Promise<CredentialResult> {
	const explicitKey = getProviderConfig(state.config, providerId)?.apiKey;
	return dependencies.resolveCredential
		? dependencies.resolveCredential(providerId, explicitKey)
		: dependencies.fallbackCredential(providerId, explicitKey);
}

async function cacheCredentialsMatch(
	state: RegistryState,
	providerIds: string[],
	stamps: Record<string, string> | undefined,
	stampFor: (providerId: string) => Promise<string>,
): Promise<boolean> {
	if (!stamps) return false;
	const ids = new Set([...providerIds, ...Object.keys(stamps)]);
	const checks = await Promise.all(
		[...ids].map(async (id) => stamps[id] !== undefined && stamps[id] === (await stampFor(id))),
	);
	if (!checks.every(Boolean)) return false;
	for (const [id, stamp] of Object.entries(stamps)) state.credentialStamps.set(id, stamp);
	return true;
}

/**
 * Persist the current provider map to the shared file cache.
 */
export async function saveRegistryToCache(state: RegistryState, scopedProviders?: readonly string[]): Promise<void> {
	try {
		const scopedSet =
			scopedProviders && scopedProviders.length > 0
				? new Set(scopedProviders.map((id) => normalizeProviderId(id) ?? id))
				: null;

		if (scopedSet) {
			const saves: Promise<void>[] = [];
			for (const id of scopedSet) {
				const provider = state.providerMap.get(id);
				const cacheKey = catalogCacheKey(`${CACHE_KEY_PREFIX}${id}`);
				if (provider) saves.push(state.cache.set(cacheKey, provider));
				else saves.push(state.cache.invalidate(cacheKey));
			}
			const existingAll = await state.cache.get<ProviderInfo[]>(catalogCacheKey("providers_all"));
			if (existingAll?.data && Array.isArray(existingAll.data)) {
				const byId = new Map(existingAll.data.map((p) => [p.id, p]));
				for (const id of scopedSet) {
					const provider = state.providerMap.get(id);
					if (provider) byId.set(provider.id, provider);
					else byId.delete(id);
				}
				saves.push(
					state.cache.set(catalogCacheKey("providers_all"), Array.from(byId.values()), {
						timestamp: existingAll.timestamp,
					}),
				);
			}
			if (state.credentialStamps.size > 0) {
				const existingStamps = await state.cache.get<Record<string, string>>(catalogCacheKey(CREDENTIAL_STAMPS_KEY));
				const mergedStamps = { ...(existingStamps?.data ?? {}) };
				for (const id of scopedSet) {
					const stamp = state.credentialStamps.get(id);
					if (stamp !== undefined) mergedStamps[id] = stamp;
					else delete mergedStamps[id];
				}
				saves.push(
					state.cache.set(catalogCacheKey(CREDENTIAL_STAMPS_KEY), mergedStamps, {
						timestamp: existingStamps?.timestamp,
					}),
				);
			}
			await Promise.all(saves);
			return;
		}

		const providers = Array.from(state.providerMap.values());
		const saves = providers.map((provider) =>
			state.cache.set(catalogCacheKey(`${CACHE_KEY_PREFIX}${provider.id}`), provider),
		);
		saves.push(state.cache.set(catalogCacheKey("providers_all"), providers));
		if (state.credentialStamps.size > 0) {
			saves.push(state.cache.set(catalogCacheKey(CREDENTIAL_STAMPS_KEY), Object.fromEntries(state.credentialStamps)));
		}
		await Promise.all(saves);
	} catch {
		// I intentionally ignore cache write failures so discovery still succeeds.
	}
}
