/**
 * kosha-discovery — Discovery orchestration, enrichment, and runtime plumbing.
 *
 * Coordinates live provider discovery, enrichment, cache hydration, manifest
 * merge/quarantine, and delta emission while delegating pure merge rules,
 * manifest locking, anomaly logging, and cache I/O to focused modules.
 * @module
 */

import { catalogCacheKey, loadActiveCatalog, resetLocalCatalogCache } from "./catalog-source.js";
import * as modelsDevCatalog from "./discovery/modelsdev-catalog.js";
import * as snapshotCatalog from "./discovery/snapshot-catalog.js";
import * as directPricing from "./enrichment/direct-pricing.js";
import * as litellmCatalog from "./enrichment/litellm-catalog.js";
import { applyManifestHolds } from "./manifest-merge.js";
import { exportRegistryManifest, readPreviousManifest, resolveManifestPath } from "./manifest-store.js";
import { sanitizeModelPricing } from "./price-trust.js";
import { getProviderConfig, getProviderDescriptor, isLocalProvider, normalizeProviderId } from "./provider-catalog.js";
import {
	applyCuratedPricing,
	CACHE_KEY_PREFIX,
	credentialStamp,
	resolveProviderCredential,
	saveRegistryToCache,
} from "./registry-cache.js";
import type { DiscoveryDependencies, RegistryState } from "./registry-state.js";
import { StaleCachePolicy } from "./resilience.js";
import { getSubscriptionPlan } from "./subscription-plans.js";
import type { CredentialResult, DiscoveryError, DiscoveryOptions, Enricher, ProviderDiscoverer, ProviderInfo } from "./types.js";

export type { PriceAnchor, PricingHold } from "./manifest-merge.js";
export {
	applyManifestHolds,
	citedFieldsMatching,
	highestRates,
	isCuratedSchedule,
	keepReportedSecondaryRates,
	mergeManifests,
	PRICE_HOLD_TAGS,
	PRICING_QUARANTINE_THRESHOLD,
	PRICING_SOURCES_DISAGREE,
} from "./manifest-merge.js";
export { type AcceptHeldPriceResult, acceptHeldPrice, CATALOG_ONLY_FILE, exportRegistryManifest, REGISTRY_MANIFEST_PATH } from "./manifest-store.js";
export { ANOMALY_FILE, appendAnomalies, detectPricingAnomalies, type PricingAnomaly, unloggedAnomalies } from "./pricing-anomalies.js";
export {
	applyCuratedPricing,
	credentialStamp,
	fallbackRegistryCredential,
	getRegistryCredentialResolver,
	loadRegistryFromCache,
	resolveProviderCredential,
	saveRegistryToCache,
} from "./registry-cache.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Run provider discovery, enrichment, caching, manifest merge, and delta emission.
 */
function resetAllCatalogCaches(includeLocal = true): void {
	// Defensive try/catch: vitest partial vi.mock proxies throw on unmocked property access.
	const call = (fn: () => void) => {
		try {
			fn();
		} catch {
			// unmocked export in test harness
		}
	};
	call(() => modelsDevCatalog.resetModelsDevCatalogCache?.());
	call(() => litellmCatalog.resetLiteLLMCatalogCache?.());
	call(() => directPricing.resetDirectPricingCache?.());
	if (includeLocal) {
		call(() => snapshotCatalog.resetSnapshotCatalogCache?.());
		call(() => resetLocalCatalogCache());
	}
}

export async function registryDiscover(
	state: RegistryState,
	dependencies: DiscoveryDependencies,
	options?: DiscoveryOptions,
): Promise<ProviderInfo[]> {
	const beforeSnapshot = dependencies.snapshotForDelta();
	const providers = options?.providers?.map((providerId) => normalizeProviderId(providerId) ?? providerId);
	const force = options?.force ?? false;

	if (force) {
		resetAllCatalogCaches(true);
	} else {
		const loaded = await dependencies.loadFromCache(providers);
		if (loaded) {
			attributePricingSources(state, capturePricedModelKeys(state));
			sanitizeRegistryPricing(state);
			const manifest = await readPreviousManifest(resolveManifestPath(state));
			if (manifest && applyManifestHolds(state, manifest)) state.lastSnapshotCache = null;
			dependencies.recordDiscoveryMutation(beforeSnapshot);
			return Array.from(state.providerMap.values());
		}
	}

	const discoverers = await dependencies.loadDiscoverers(providers, options?.includeLocal);
	const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
	const degraded: DiscoveryError[] = [];
	const sharedKeys: SharedKeyLedger = { accepted: new Set(), refused: new Map() };
	const results = await Promise.allSettled(
		discoverers.map((discoverer) => discoverProvider(state, dependencies, discoverer, timeout, degraded, sharedKeys)),
	);

	state.lastDiscoveryErrors = [...degraded];
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		if (result.status === "fulfilled") {
			if (result.value) {
				state.providerMap.set(result.value.id, result.value);
			}
			continue;
		}

		const discoverer = discoverers[index];
		state.lastDiscoveryErrors.push({
			providerId: discoverer.providerId,
			providerName: discoverer.providerName,
			error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			timestamp: Date.now(),
		});
	}
	reportRefusedSharedKeys(state, sharedKeys);

	const preEnrichmentPriced = capturePricedModelKeys(state);

	if (options?.enrichWithPricing ?? true) {
		await dependencies.enrichModels();
	}

	for (const [providerId, providerInfo] of state.providerMap) {
		state.providerMap.set(providerId, {
			...providerInfo,
			models: applyCuratedPricing(providerInfo.models),
		});
	}

	attributePricingSources(state, preEnrichmentPriced);
	dependencies.populateModelAliases();
	state.discoveredAt = Date.now();
	await dependencies.saveToCache(providers);
	state.lastSnapshotCache = null;
	const merged = await exportRegistryManifest(state, { scopedProviders: providers });
	if (merged && applyManifestHolds(state, merged)) {
		// Write held prices back to the TTL cache so subsequent cache hits never resurrect suspect rates.
		await dependencies.saveToCache(providers);
		state.lastSnapshotCache = null;
	}
	// Emit delta AFTER quarantine holds apply so watchers and deltaHistory
	// never receive unheld suspect prices.
	dependencies.recordDiscoveryMutation(beforeSnapshot);
	return Array.from(state.providerMap.values());
}

/**
 * Force a fresh discovery pass for one provider or the full registry.
 * Resets in-process catalog singletons so long-running processes always fetch
 * the latest upstream pricing while keeping on-disk stale cache intact as a
 * fallback if a live provider call fails.
 */
export async function registryRefresh(
	_state: RegistryState,
	discover: (options?: DiscoveryOptions) => Promise<ProviderInfo[]>,
	providerId?: string,
): Promise<void> {
	resetAllCatalogCaches(true);
	if (providerId) {
		const normalizedProviderId = normalizeProviderId(providerId) ?? providerId;
		await discover({ providers: [normalizedProviderId], force: true });
		return;
	}
	await discover({ force: true });
}

/**
 * Dynamically load discoverers while respecting config and local filters.
 */
export async function loadRegistryDiscoverers(
	state: RegistryState,
	providerIds?: string[],
	includeLocal?: boolean,
): Promise<ProviderDiscoverer[]> {
	try {
		const discoveryModule = await import("./discovery/index.js");
		let discoverers: ProviderDiscoverer[] = discoveryModule.getAllDiscoverers({
			ollamaBaseUrl: getProviderConfig(state.config, "ollama")?.baseUrl,
			llamaCppBaseUrl: getProviderConfig(state.config, "llama.cpp")?.baseUrl,
		});

		if (providerIds && providerIds.length > 0) {
			const normalizedProviderIds = providerIds.map((providerId) => normalizeProviderId(providerId) ?? providerId);
			discoverers = discoverers.filter((discoverer) => normalizedProviderIds.includes(discoverer.providerId));
		}

		if (includeLocal === false) {
			discoverers = discoverers.filter((discoverer) => !isLocalProvider(discoverer.providerId));
		}

		if (state.config.providers) {
			discoverers = discoverers.filter(
				(discoverer) => getProviderConfig(state.config, discoverer.providerId)?.enabled !== false,
			);
			for (const discoverer of discoverers) {
				const customBaseUrl = getProviderConfig(state.config, discoverer.providerId)?.baseUrl;
				if (customBaseUrl && isAllowedCustomBaseUrl(customBaseUrl, isLocalProvider(discoverer.providerId))) {
					(discoverer as { baseUrl: string }).baseUrl = stripTrailingSlashes(customBaseUrl);
				}
			}
		}

		return discoverers;
	} catch {
		return [];
	}
}

function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
	return end === value.length ? value : value.slice(0, end);
}

function isAllowedCustomBaseUrl(rawUrl: string, allowInsecureLocal: boolean): boolean {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol === "https:") return true;
		if (parsed.protocol !== "http:") return false;
		if (allowInsecureLocal) return true;
		const host = parsed.hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

/**
 * Enrich the in-memory model set with pricing metadata when available.
 */
export async function enrichRegistryModels(
	state: RegistryState,
	options?: { refreshExisting?: boolean },
): Promise<void> {
	try {
		const catalog = await loadActiveCatalog();
		const { CatalogEnricher, DirectProviderPricingEnricher, LiteLLMEnricher } = await import("./enrichment/index.js");
		const enricher = catalog ? new CatalogEnricher(catalog) : new LiteLLMEnricher();
		const directEnricher = new DirectProviderPricingEnricher();

		for (const [providerId, providerInfo] of state.providerMap) {
			try {
				const withDirect = await directEnricher.enrich(providerInfo.models);
				const enriched = await enricher.enrich(withDirect, options);
				state.providerMap.set(providerId, { ...providerInfo, models: enriched });
			} catch {
				// Non-fatal so base discovery remains useful.
			}
		}
	} catch {
		// Silently skip enrichment when optional module is absent.
	}
}

/**
 * Enrichment-only result for the `kosha enrich` CLI command.
 */
export interface EnrichOnlyResult {
	/** Total models across all providers. */
	modelCount: number;
	/** Models that gained new cache read/write pricing. */
	cachePricingUpdated: number;
	/** Models that gained new batch pricing. */
	batchPricingUpdated: number;
}

/**
 * Load cached provider data, re-run LiteLLM enrichment, and persist results.
 */
export async function registryEnrichOnly(state: RegistryState): Promise<EnrichOnlyResult | null> {
	const allEntry = await state.cache.get<ProviderInfo[]>(catalogCacheKey("providers_all"));
	if (!allEntry) return null;

	resetAllCatalogCaches(false);
	for (const provider of allEntry.data) {
		state.providerMap.set(provider.id, provider);
	}
	state.discoveredAt = allEntry.timestamp;
	const stamps = await state.cache.get<Record<string, string>>(catalogCacheKey("credential_stamps"));
	for (const [id, stamp] of Object.entries(stamps?.data ?? {})) state.credentialStamps.set(id, stamp);

	const before = countPricingFields(state);
	const preEnrichmentPriced = capturePricedModelKeys(state);

	await enrichRegistryModels(state, { refreshExisting: true });
	for (const [providerId, providerInfo] of state.providerMap) {
		state.providerMap.set(providerId, {
			...providerInfo,
			models: applyCuratedPricing(providerInfo.models),
		});
	}
	attributePricingSources(state, preEnrichmentPriced);
	populateRegistryModelAliases(state);
	await saveRegistryToCache(state);
	state.lastSnapshotCache = null;
	const merged = await exportRegistryManifest(state);
	if (merged && applyManifestHolds(state, merged)) {
		await saveRegistryToCache(state);
		state.lastSnapshotCache = null;
	}

	const after = countPricingFields(state);
	return {
		modelCount: Array.from(state.providerMap.values()).reduce((sum, p) => sum + p.models.length, 0),
		cachePricingUpdated: Math.max(0, after.cachePricing - before.cachePricing),
		batchPricingUpdated: Math.max(0, after.batchPricing - before.batchPricing),
	};
}

function countPricingFields(state: RegistryState): { cachePricing: number; batchPricing: number } {
	let cachePricing = 0;
	let batchPricing = 0;
	for (const providerInfo of state.providerMap.values()) {
		for (const model of providerInfo.models) {
			if (model.pricing?.cacheReadPerMillion !== undefined || model.pricing?.cacheWritePerMillion !== undefined)
				cachePricing++;
			if (model.pricing?.batchInputPerMillion !== undefined || model.pricing?.batchOutputPerMillion !== undefined)
				batchPricing++;
		}
	}
	return { cachePricing, batchPricing };
}

function sanitizeRegistryPricing(state: RegistryState): void {
	for (const [providerId, providerInfo] of state.providerMap) {
		const models = providerInfo.models.map(sanitizeModelPricing);
		if (models.some((m, i) => m !== providerInfo.models[i]))
			state.providerMap.set(providerId, { ...providerInfo, models });
	}
}

function modelHasUsablePricing(model: { pricing?: { inputPerMillion?: number; outputPerMillion?: number } }): boolean {
	const pricing = model.pricing;
	return !!pricing && pricing.inputPerMillion !== undefined && pricing.outputPerMillion !== undefined;
}

function modelPricingKey(providerId: string, model: { id: string }): string {
	return `${providerId}:${model.id}`;
}

function capturePricedModelKeys(state: RegistryState): Set<string> {
	const keys = new Set<string>();
	for (const [providerId, providerInfo] of state.providerMap) {
		for (const model of providerInfo.models) {
			if (modelHasUsablePricing(model)) {
				keys.add(modelPricingKey(providerId, model));
			}
		}
	}
	return keys;
}

function attributePricingSources(state: RegistryState, preEnrichmentPriced: Set<string>): void {
	for (const [providerId, providerInfo] of state.providerMap) {
		for (const model of providerInfo.models) {
			if (model.pricingSource) continue;
			if (modelHasUsablePricing(model)) {
				const fromDiscovery = preEnrichmentPriced.has(modelPricingKey(providerId, model));
				const isLiveApi =
					model.priceEvidence?.some((entry) => entry.source === "provider-api") === true ||
					(fromDiscovery && model.source === "api");
				model.pricingSource = isLiveApi ? "provider-live" : fromDiscovery ? "static-seed" : "litellm";
			} else {
				model.pricingSource = "missing";
			}
		}
	}
}

/**
 * Populate reverse aliases onto discovered models for legacy consumers.
 */
export function populateRegistryModelAliases(state: RegistryState): void {
	for (const providerInfo of state.providerMap.values()) {
		for (const model of providerInfo.models) {
			const reverseAliases = state.aliasResolver.reverseAliases(model.id);
			if (reverseAliases.length > 0) {
				model.aliases = reverseAliases;
			}
		}
	}
}

async function discoverProvider(
	state: RegistryState,
	dependencies: DiscoveryDependencies,
	discoverer: ProviderDiscoverer,
	timeout: number,
	degraded: DiscoveryError[],
	sharedKeys: SharedKeyLedger,
): Promise<ProviderInfo | null> {
	const breaker = state.healthTracker.breaker(discoverer.providerId);

	if (!breaker.canExecute()) {
		const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
			state.cache,
			catalogCacheKey(`${CACHE_KEY_PREFIX}${discoverer.providerId}`),
		);
		return stale?.data ?? null;
	}

	const credential = await resolveProviderCredential(state, dependencies, discoverer.providerId);
	state.credentialStamps.set(discoverer.providerId, credentialStamp(credential));
	return discoverWithCredential(state, dependencies, discoverer, timeout, degraded, sharedKeys, credential);
}

async function discoverWithCredential(
	state: RegistryState,
	dependencies: DiscoveryDependencies,
	discoverer: ProviderDiscoverer,
	timeout: number,
	degraded: DiscoveryError[],
	sharedKeys: SharedKeyLedger,
	credential: CredentialResult,
): Promise<ProviderInfo | null> {
	const breaker = state.healthTracker.breaker(discoverer.providerId);
	const startedAt = Date.now();
	const isPlan = getProviderDescriptor(discoverer.providerId)?.subscriptionPlan === true;
	if (isPlan && (credential.source === "none" || state.config.keyless)) return null;

	try {
		const keylessPath = state.config.keyless ? discoverer.discoverKeyless?.bind(discoverer) : undefined;
		const models = keylessPath ? await keylessPath() : await discoverer.discover(credential, { timeout });
		breaker.onSuccess();
		dependencies.recordObservation(discoverer.providerId, {
			latencyMs: Date.now() - startedAt,
			errorType: null,
		});
		if (credential.shared && credential.envVar) sharedKeys.accepted.add(credential.envVar);

		return {
			id: discoverer.providerId,
			name: discoverer.providerName,
			baseUrl: discoverer.baseUrl,
			authenticated: credential.source !== "none",
			credentialSource: credential.source,
			models,
			lastRefreshed: Date.now(),
		};
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (credential.shared && credential.envVar && isTentativeKeyMiss(error)) {
			if (!isPlanKeyUnverified(error)) {
				const refusers = sharedKeys.refused.get(credential.envVar) ?? [];
				refusers.push(discoverer.providerId);
				sharedKeys.refused.set(credential.envVar, refusers);
			}
			if (isPlan) return null;
			return listedWithoutKey(state, discoverer, timeout);
		}
		breaker.onFailure(errorMessage);
		dependencies.recordObservation(discoverer.providerId, {
			latencyMs: Date.now() - startedAt,
			errorType: dependencies.classifyError(errorMessage),
		});

		const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
			state.cache,
			catalogCacheKey(`${CACHE_KEY_PREFIX}${discoverer.providerId}`),
		);
		if (stale) {
			if (credential.source === "none") {
				return {
					...stale.data,
					authenticated: false,
					credentialSource: "none",
					unreachableReason: errorMessage,
				};
			}
			degraded.push({
				providerId: discoverer.providerId,
				providerName: discoverer.providerName,
				error: errorMessage,
				timestamp: Date.now(),
			});
			return { ...stale.data, degradedReason: errorMessage, degradedSource: "cache" };
		}

		if (credential.source !== "none") {
			try {
				const models = await discoverer.discover({ source: "none" }, { timeout });
				if (models.length > 0) {
					degraded.push({
						providerId: discoverer.providerId,
						providerName: discoverer.providerName,
						error: errorMessage,
						timestamp: Date.now(),
					});
					return {
						id: discoverer.providerId,
						name: discoverer.providerName,
						baseUrl: discoverer.baseUrl,
						authenticated: false,
						credentialSource: "none",
						models,
						lastRefreshed: Date.now(),
						degradedReason: errorMessage,
						degradedSource: "catalog",
					};
				}
			} catch {
				/* the keyless path failed too — report the original error */
			}
		}

		throw error;
	}
}

interface SharedKeyLedger {
	accepted: Set<string>;
	refused: Map<string, string[]>;
}

function isPlanKeyUnverified(error: unknown): boolean {
	return error instanceof Error && error.name === "PlanKeyUnverifiedError";
}

function isTentativeKeyMiss(error: unknown): boolean {
	if (isPlanKeyUnverified(error)) return true;
	return error instanceof Error && /API error:\s*40[13]\b/.test(error.message);
}

async function listedWithoutKey(
	state: RegistryState,
	discoverer: ProviderDiscoverer,
	timeout: number,
): Promise<ProviderInfo | null> {
	try {
		const models = await discoverer.discover({ source: "none" }, { timeout });
		if (models.length > 0) {
			return {
				id: discoverer.providerId,
				name: discoverer.providerName,
				baseUrl: discoverer.baseUrl,
				authenticated: false,
				credentialSource: "none",
				models,
				lastRefreshed: Date.now(),
			};
		}
	} catch {
		/* fall back to the last good listing */
	}
	const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
		state.cache,
		catalogCacheKey(`${CACHE_KEY_PREFIX}${discoverer.providerId}`),
	);
	return stale ? { ...stale.data, authenticated: false, credentialSource: "none" } : null;
}

function reportRefusedSharedKeys(state: RegistryState, ledger: SharedKeyLedger): void {
	for (const [envVar, refusers] of ledger.refused) {
		if (ledger.accepted.has(envVar)) continue;
		const families = new Set(refusers.map((id) => getSubscriptionPlan(id)?.family ?? id));
		const hint = families.has("alibaba")
			? " If it is an Alibaba Coding Plan key, set ALIBABA_CODING_PLAN_API_KEY instead: that host can't test a key."
			: "";
		const message = `${envVar} was refused by every provider that reads it: ${refusers.join(", ")} (API error: 401).${hint}`;
		for (const id of refusers) {
			const provider = state.providerMap.get(id);
			if (provider) state.providerMap.set(id, { ...provider, degradedReason: message, degradedSource: "catalog" });
		}
		state.lastDiscoveryErrors.push({
			providerId: refusers[0],
			providerName: envVar,
			error: message,
			timestamp: Date.now(),
		});
	}
}
