/**
 * kosha-discovery — Discovery, enrichment, and cache helpers.
 *
 * I keep provider discovery and runtime plumbing here so the registry façade
 * can stay small without losing the existing behavior.
 * @module
 */

import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { StaleCachePolicy } from "./resilience.js";
import { getProviderConfig, isLocalProvider, normalizeProviderId } from "./provider-catalog.js";
import { registryDiscoverySnapshot } from "./registry-discovery.js";
import type { RegistryState, DiscoveryDependencies } from "./registry-state.js";
import type {
	CredentialResult,
	DiscoveryOptions,
	Enricher,
	ProviderDiscoverer,
	ProviderInfo,
} from "./types.js";

const DEFAULT_CACHE_TTL_MS = 86_400_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_KEY_PREFIX = "provider_";

/**
 * Canonical, third-party consumable registry manifest path.
 * I keep it outside the TTL cache directory so tools like jq, duckdb, or
 * language SDKs can read a single stable file without worrying about
 * cache envelopes or internal layout changes.
 */
export const REGISTRY_MANIFEST_PATH = join(homedir(), ".kosha", "registry.json");

const FALLBACK_ENV_MAP: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	together: "TOGETHER_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	groq: "GROQ_API_KEY",
	mistral: "MISTRAL_API_KEY",
	deepinfra: "DEEPINFRA_API_KEY",
	cohere: "CO_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	moonshot: "MOONSHOT_API_KEY",
	glm: "GLM_API_KEY",
	zai: "ZAI_API_KEY",
	minimax: "MINIMAX_API_KEY",
};

/**
 * Run provider discovery, enrichment, caching, and delta emission.
 */
export async function registryDiscover(
	state: RegistryState,
	dependencies: DiscoveryDependencies,
	options?: DiscoveryOptions,
): Promise<ProviderInfo[]> {
	const beforeSnapshot = dependencies.snapshotForDelta();
	const providers = options?.providers?.map((providerId) => normalizeProviderId(providerId) ?? providerId);
	const force = options?.force ?? false;

	if (!force) {
		const loaded = await dependencies.loadFromCache(providers);
		if (loaded) {
			dependencies.recordDiscoveryMutation(beforeSnapshot);
			// Only refresh the canonical manifest for full-registry cache hits.
			// Scoped provider rehydration can carry cache-derived state that should
			// not be published as a fresh top-level manifest snapshot.
			if (!providers || providers.length === 0) {
				await exportRegistryManifest(state);
			}
			return Array.from(state.providerMap.values());
		}
	}

	const discoverers = await dependencies.loadDiscoverers(providers, options?.includeLocal);
	const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
	const results = await Promise.allSettled(discoverers.map((discoverer) =>
		discoverProvider(state, dependencies, discoverer, timeout),
	));

	state.lastDiscoveryErrors = [];
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

	if (options?.enrichWithPricing ?? true) {
		await dependencies.enrichModels();
	}

	dependencies.populateModelAliases();
	state.discoveredAt = Date.now();
	await dependencies.saveToCache();
	dependencies.recordDiscoveryMutation(beforeSnapshot);
	// Write the consumer-facing manifest last, after recordDiscoveryMutation
	// has advanced the cursor — that way the snapshot's cursor reflects the
	// post-discovery revision instead of a stale pre-mutation value.
	await exportRegistryManifest(state);
	return Array.from(state.providerMap.values());
}

/**
 * Force a fresh discovery pass for one provider or the full registry.
 */
export async function registryRefresh(
	state: RegistryState,
	discover: (options?: DiscoveryOptions) => Promise<ProviderInfo[]>,
	providerId?: string,
): Promise<void> {
	if (providerId) {
		const normalizedProviderId = normalizeProviderId(providerId) ?? providerId;
		await state.cache.invalidate(`${CACHE_KEY_PREFIX}${normalizedProviderId}`);
		await discover({ providers: [normalizedProviderId], force: true });
		return;
	}

	await state.cache.clear();
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
			discoverers = discoverers.filter((discoverer) =>
				getProviderConfig(state.config, discoverer.providerId)?.enabled !== false
			);
		}

		return discoverers;
	} catch {
		return [];
	}
}

/**
 * Dynamically load the credential resolver when available.
 */
export async function getRegistryCredentialResolver():
Promise<{ resolve: (providerId: string, explicitKey?: string) => Promise<CredentialResult> } | null> {
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
export function fallbackRegistryCredential(
	providerId: string,
	explicitKey?: string,
): CredentialResult {
	const normalizedProviderId = normalizeProviderId(providerId) ?? providerId;
	if (explicitKey) {
		return { apiKey: explicitKey, source: "config" };
	}

	const envVar = FALLBACK_ENV_MAP[normalizedProviderId];
	const value = envVar ? process.env[envVar] : undefined;
	return value ? { apiKey: value, source: "env" } : { source: "none" };
}

/**
 * Enrich the in-memory model set with pricing metadata when available.
 */
export async function enrichRegistryModels(state: RegistryState): Promise<void> {
	try {
		const { LiteLLMEnricher } = await import("./enrichment/index.js");
		const enricher: Enricher = new LiteLLMEnricher();

		for (const [providerId, providerInfo] of state.providerMap) {
			try {
				const enriched = await enricher.enrich(providerInfo.models);
				state.providerMap.set(providerId, { ...providerInfo, models: enriched });
			} catch {
				// I keep enrichment failures non-fatal so base discovery remains useful.
			}
		}
	} catch {
		// I silently skip enrichment when the optional module is not present.
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
 *
 * This is the lightweight alternative to full re-discovery — no provider API
 * calls, just a fetch from the litellm community catalogue. Returns `null`
 * when no cached data is available.
 */
export async function registryEnrichOnly(state: RegistryState): Promise<EnrichOnlyResult | null> {
	const ttl = state.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const allEntry = await state.cache.get<ProviderInfo[]>("providers_all");
	if (!allEntry) return null;

	// Accept stale cache too — enrichment-only shouldn't fail just because
	// the TTL expired. The user explicitly asked for enrichment, not discovery.
	for (const provider of allEntry.data) {
		state.providerMap.set(provider.id, provider);
	}
	state.discoveredAt = allEntry.timestamp;

	// Snapshot pricing before enrichment to count how many models get updates.
	const before = countPricingFields(state);

	await enrichRegistryModels(state);
	populateRegistryModelAliases(state);
	await saveRegistryToCache(state);
	await exportRegistryManifest(state);

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
			if (model.pricing?.cacheReadPerMillion !== undefined || model.pricing?.cacheWritePerMillion !== undefined) cachePricing++;
			if (model.pricing?.batchInputPerMillion !== undefined || model.pricing?.batchOutputPerMillion !== undefined) batchPricing++;
		}
	}
	return { cachePricing, batchPricing };
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

/**
 * Load provider data from disk cache when it is still fresh.
 */
export async function loadRegistryFromCache(
	state: RegistryState,
	providerIds?: string[],
): Promise<boolean> {
	const ttl = state.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

	if (!providerIds || providerIds.length === 0) {
		const allEntry = await state.cache.get<ProviderInfo[]>("providers_all");
		if (!allEntry || state.cache.isExpired(allEntry.timestamp, ttl)) {
			return false;
		}

		for (const provider of allEntry.data) {
			state.providerMap.set(provider.id, provider);
		}
		state.discoveredAt = allEntry.timestamp;
		return true;
	}

	for (const providerId of providerIds) {
		const entry = await state.cache.get<ProviderInfo>(`${CACHE_KEY_PREFIX}${providerId}`);
		if (!entry || state.cache.isExpired(entry.timestamp, ttl)) {
			return false;
		}
		state.providerMap.set(providerId, entry.data);
	}

	state.discoveredAt = Date.now();
	return true;
}

/**
 * Persist the current provider map to the shared file cache.
 */
export async function saveRegistryToCache(state: RegistryState): Promise<void> {
	try {
		const providers = Array.from(state.providerMap.values());
		const saves = providers.map((provider) => state.cache.set(`${CACHE_KEY_PREFIX}${provider.id}`, provider));
		saves.push(state.cache.set("providers_all", providers));
		await Promise.all(saves);
	} catch {
		// I intentionally ignore cache write failures so discovery still succeeds.
	}
}

/**
 * Export a stable, human-and-machine-readable manifest of the current
 * registry state to `~/.kosha/registry.json`. Third-party consumers
 * (CLIs in other languages, jq pipelines, CI jobs, dashboards) can read
 * this file directly — it holds the stable v1 discovery snapshot schema,
 * not the internal cache envelope.
 *
 * I make this a best-effort write: if the filesystem refuses, discovery
 * still completed successfully, so I swallow errors rather than failing
 * the whole command.
 */
export async function exportRegistryManifest(state: RegistryState): Promise<void> {
	try {
		const snapshot = state.lastSnapshotCache ?? registryDiscoverySnapshot(state);
		state.lastSnapshotCache = snapshot;
		await mkdir(join(homedir(), ".kosha"), { recursive: true });
		await writeFile(REGISTRY_MANIFEST_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
	} catch {
		// I keep manifest export non-fatal — the cache still works either way.
	}
}

async function discoverProvider(
	state: RegistryState,
	dependencies: DiscoveryDependencies,
	discoverer: ProviderDiscoverer,
	timeout: number,
): Promise<ProviderInfo | null> {
	const breaker = state.healthTracker.breaker(discoverer.providerId);
	const startedAt = Date.now();

	if (!breaker.canExecute()) {
		const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
			state.cache,
			`${CACHE_KEY_PREFIX}${discoverer.providerId}`,
		);
		return stale?.data ?? null;
	}

	const explicitKey = getProviderConfig(state.config, discoverer.providerId)?.apiKey;
	const credential = dependencies.resolveCredential
		? await dependencies.resolveCredential(discoverer.providerId, explicitKey)
		: dependencies.fallbackCredential(discoverer.providerId, explicitKey);

	try {
		const models = await discoverer.discover(credential, { timeout });
		breaker.onSuccess();
		dependencies.recordObservation(discoverer.providerId, {
			latencyMs: Date.now() - startedAt,
			errorType: null,
		});

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
		breaker.onFailure(errorMessage);
		dependencies.recordObservation(discoverer.providerId, {
			latencyMs: Date.now() - startedAt,
			errorType: dependencies.classifyError(errorMessage),
		});

		const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
			state.cache,
			`${CACHE_KEY_PREFIX}${discoverer.providerId}`,
		);
		if (stale) {
			return stale.data;
		}

		throw error;
	}
}
