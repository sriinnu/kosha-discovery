/**
 * kosha-discovery — ModelRegistry: the heart of kosha.
 *
 * Orchestrates provider discovery, credential resolution, enrichment,
 * caching, and querying into a single, easy-to-use registry class.
 * @module
 */

import type {
	CredentialResult,
	DiscoveryOptions,
	Enricher,
	KoshaConfig,
	ModelCard,
	ModelMode,
	ProviderDiscoverer,
	ProviderInfo,
} from "./types.js";
import { AliasResolver } from "./aliases.js";
import { KoshaCache } from "./cache.js";

const DEFAULT_CACHE_TTL_MS = 86_400_000; // 24 hours
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_KEY_PREFIX = "provider_";

/**
 * The main orchestrating registry for AI model discovery.
 *
 * - Discovery is explicit: call `discover()` to populate the registry.
 * - Queries (`models()`, `model()`) work against the in-memory store.
 * - Results are cached to disk to avoid redundant API calls.
 */
export class ModelRegistry {
	private providerMap: Map<string, ProviderInfo> = new Map();
	private aliasResolver: AliasResolver;
	private cache: KoshaCache;
	private config: KoshaConfig;
	private discoveredAt = 0;

	constructor(config?: KoshaConfig) {
		this.config = config ?? {};
		this.aliasResolver = new AliasResolver(this.config.aliases);
		this.cache = new KoshaCache(this.config.cacheDir);
	}

	// ---------------------------------------------------------------------------
	// Discovery
	// ---------------------------------------------------------------------------

	/**
	 * Run discovery across all (or selected) providers.
	 *
	 * 1. Loads discoverers for the requested providers.
	 * 2. Resolves credentials for each provider.
	 * 3. Runs discovery in parallel with `Promise.allSettled`.
	 * 4. Optionally enriches models with litellm pricing data.
	 * 5. Caches results to disk.
	 */
	async discover(options?: DiscoveryOptions): Promise<ProviderInfo[]> {
		const force = options?.force ?? false;

		// Try loading from cache first (unless forced)
		if (!force) {
			const loaded = await this.loadFromCache(options?.providers);
			if (loaded) {
				return this.providers_list();
			}
		}

		const discoverers = await this.loadDiscoverers(options?.providers, options?.includeLocal);
		const credentialResolver = await this.getCredentialResolver();
		const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

		// Run discovery in parallel — one failing provider does not block others
		const results = await Promise.allSettled(
			discoverers.map(async (discoverer) => {
				const explicitKey = this.config.providers?.[discoverer.providerId]?.apiKey;
				const credential = credentialResolver
					? await credentialResolver.resolve(discoverer.providerId, explicitKey)
					: this.fallbackCredential(discoverer.providerId, explicitKey);

				const models = await discoverer.discover(credential, { timeout });

				const providerInfo: ProviderInfo = {
					id: discoverer.providerId,
					name: discoverer.providerName,
					baseUrl: discoverer.baseUrl,
					authenticated: credential.source !== "none",
					credentialSource: credential.source,
					models,
					lastRefreshed: Date.now(),
				};

				return providerInfo;
			}),
		);

		// Collect successful results
		for (const result of results) {
			if (result.status === "fulfilled") {
				this.providerMap.set(result.value.id, result.value);
			}
		}

		// Enrich with litellm pricing if requested (default: true)
		const enrichWithPricing = options?.enrichWithPricing ?? true;
		if (enrichWithPricing) {
			await this.enrichModels();
		}

		// Populate alias reverse-mappings on model cards
		this.populateModelAliases();

		this.discoveredAt = Date.now();

		// Persist to cache
		await this.saveToCache();

		return this.providers_list();
	}

	/**
	 * Force re-discovery for one or all providers (bypasses cache).
	 */
	async refresh(providerId?: string): Promise<void> {
		if (providerId) {
			// Invalidate cache for the specific provider
			await this.cache.invalidate(`${CACHE_KEY_PREFIX}${providerId}`);
			await this.discover({ providers: [providerId], force: true });
		} else {
			// Invalidate all and re-discover
			await this.cache.clear();
			await this.discover({ force: true });
		}
	}

	// ---------------------------------------------------------------------------
	// Querying
	// ---------------------------------------------------------------------------

	/**
	 * Return all known models, optionally filtered by provider, mode, or capability.
	 * Deduplicates by model ID.
	 */
	models(filter?: { provider?: string; mode?: ModelMode; capability?: string }): ModelCard[] {
		const seen = new Set<string>();
		const result: ModelCard[] = [];

		for (const providerInfo of this.providerMap.values()) {
			if (filter?.provider && providerInfo.id !== filter.provider) {
				continue;
			}

			for (const model of providerInfo.models) {
				if (seen.has(model.id)) continue;

				if (filter?.mode && model.mode !== filter.mode) continue;
				if (filter?.capability && !model.capabilities.includes(filter.capability)) continue;

				seen.add(model.id);
				result.push(model);
			}
		}

		return result;
	}

	/**
	 * Find a single model by ID or alias.
	 * Resolves aliases first, then searches all providers.
	 */
	model(idOrAlias: string): ModelCard | undefined {
		const resolvedId = this.aliasResolver.resolve(idOrAlias);

		for (const providerInfo of this.providerMap.values()) {
			const found = providerInfo.models.find((m) => m.id === resolvedId);
			if (found) return found;
		}

		// If alias resolution didn't help, try a direct search with the original input
		if (resolvedId !== idOrAlias) return undefined;

		for (const providerInfo of this.providerMap.values()) {
			const found = providerInfo.models.find((m) => m.id === idOrAlias);
			if (found) return found;
		}

		return undefined;
	}

	/**
	 * Get a single provider's info by ID.
	 */
	provider(id: string): ProviderInfo | undefined {
		return this.providerMap.get(id);
	}

	/**
	 * List all known providers.
	 */
	providers_list(): ProviderInfo[] {
		return Array.from(this.providerMap.values());
	}

	// ---------------------------------------------------------------------------
	// Aliases
	// ---------------------------------------------------------------------------

	/**
	 * Resolve an alias to its canonical model ID. Delegates to AliasResolver.
	 */
	resolve(alias: string): string {
		return this.aliasResolver.resolve(alias);
	}

	/**
	 * Add a custom alias mapping.
	 */
	alias(short: string, modelId: string): void {
		this.aliasResolver.addAlias(short, modelId);
	}

	// ---------------------------------------------------------------------------
	// Serialization
	// ---------------------------------------------------------------------------

	/**
	 * Serialize the registry state to a plain JSON-compatible object.
	 */
	toJSON(): { providers: ProviderInfo[]; aliases: Record<string, string>; discoveredAt: number } {
		return {
			providers: this.providers_list(),
			aliases: this.aliasResolver.all(),
			discoveredAt: this.discoveredAt,
		};
	}

	/**
	 * Restore a ModelRegistry from a previously serialized JSON object.
	 */
	static fromJSON(data: { providers: ProviderInfo[]; aliases: Record<string, string>; discoveredAt: number }): ModelRegistry {
		const registry = new ModelRegistry({ aliases: data.aliases });

		for (const provider of data.providers) {
			registry.providerMap.set(provider.id, provider);
		}

		registry.discoveredAt = data.discoveredAt;
		return registry;
	}

	// ---------------------------------------------------------------------------
	// Internal — Discoverer loading
	// ---------------------------------------------------------------------------

	/**
	 * Dynamically import discoverers to avoid hard-coupling.
	 * Filters to only the requested providers if specified.
	 */
	private async loadDiscoverers(providerIds?: string[], includeLocal?: boolean): Promise<ProviderDiscoverer[]> {
		try {
			const discoveryModule = await import("./discovery/index.js");
			const all: ProviderDiscoverer[] = discoveryModule.getAllDiscoverers();

			let filtered = all;

			// Filter to requested providers
			if (providerIds && providerIds.length > 0) {
				filtered = filtered.filter((d) => providerIds.includes(d.providerId));
			}

			// Exclude local providers (ollama) unless explicitly included
			if (includeLocal === false) {
				filtered = filtered.filter((d) => d.providerId !== "ollama");
			}

			// Filter out providers that are disabled in config
			if (this.config.providers) {
				filtered = filtered.filter((d) => {
					const provConfig = this.config.providers?.[d.providerId];
					return provConfig?.enabled !== false;
				});
			}

			return filtered;
		} catch {
			// Discovery module not available — return empty
			return [];
		}
	}

	/**
	 * Dynamically import the credential resolver.
	 * Returns null if the credentials module is not available.
	 */
	private async getCredentialResolver(): Promise<{ resolve: (providerId: string, explicitKey?: string) => Promise<CredentialResult> } | null> {
		try {
			const { CredentialResolver } = await import("./credentials/index.js");
			return new CredentialResolver();
		} catch {
			return null;
		}
	}

	/**
	 * Fallback credential resolution when the credential resolver module is unavailable.
	 * Checks environment variables and explicit keys only.
	 */
	private fallbackCredential(providerId: string, explicitKey?: string): CredentialResult {
		if (explicitKey) {
			return { apiKey: explicitKey, source: "config" };
		}

		const envMap: Record<string, string> = {
			anthropic: "ANTHROPIC_API_KEY",
			openai: "OPENAI_API_KEY",
			google: "GOOGLE_API_KEY",
			openrouter: "OPENROUTER_API_KEY",
		};

		const envVar = envMap[providerId];
		if (envVar) {
			const value = process.env[envVar];
			if (value) {
				return { apiKey: value, source: "env" };
			}
		}

		return { source: "none" };
	}

	// ---------------------------------------------------------------------------
	// Internal — Enrichment
	// ---------------------------------------------------------------------------

	/**
	 * Enrich all models with litellm pricing data.
	 * Silently skips if the enrichment module is unavailable or fails.
	 */
	private async enrichModels(): Promise<void> {
		try {
			const { LiteLLMEnricher } = await import("./enrichment/index.js");
			const enricher: Enricher = new LiteLLMEnricher();

			for (const [providerId, providerInfo] of this.providerMap) {
				try {
					const enriched = await enricher.enrich(providerInfo.models);
					this.providerMap.set(providerId, { ...providerInfo, models: enriched });
				} catch {
					// Skip enrichment for this provider on failure
				}
			}
		} catch {
			// Enrichment module not available — skip silently
		}
	}

	/**
	 * Populate the `aliases` field on each ModelCard with any matching aliases
	 * from the alias resolver.
	 */
	private populateModelAliases(): void {
		for (const providerInfo of this.providerMap.values()) {
			for (const model of providerInfo.models) {
				const reverseAliases = this.aliasResolver.reverseAliases(model.id);
				if (reverseAliases.length > 0) {
					model.aliases = reverseAliases;
				}
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Internal — Cache
	// ---------------------------------------------------------------------------

	/**
	 * Attempt to load provider data from the file cache.
	 * Returns true if ALL requested providers were found in cache and are fresh.
	 */
	private async loadFromCache(providerIds?: string[]): Promise<boolean> {
		const ttl = this.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

		// If no specific providers requested, try loading the "all" key
		if (!providerIds || providerIds.length === 0) {
			const allEntry = await this.cache.get<ProviderInfo[]>("providers_all");
			if (allEntry && !this.cache.isExpired(allEntry.timestamp, ttl)) {
				for (const provider of allEntry.data) {
					this.providerMap.set(provider.id, provider);
				}
				this.discoveredAt = allEntry.timestamp;
				return true;
			}
			return false;
		}

		// Load specific providers
		let allFound = true;
		for (const providerId of providerIds) {
			const entry = await this.cache.get<ProviderInfo>(`${CACHE_KEY_PREFIX}${providerId}`);
			if (entry && !this.cache.isExpired(entry.timestamp, ttl)) {
				this.providerMap.set(providerId, entry.data);
			} else {
				allFound = false;
				break;
			}
		}

		if (allFound && providerIds.length > 0) {
			this.discoveredAt = Date.now();
		}

		return allFound;
	}

	/**
	 * Persist current provider data to the file cache.
	 * Saves both per-provider entries and an "all" key.
	 */
	private async saveToCache(): Promise<void> {
		try {
			const providers = this.providers_list();

			// Save individual provider entries
			const saves = providers.map((p) => this.cache.set(`${CACHE_KEY_PREFIX}${p.id}`, p));

			// Save the combined "all" entry
			saves.push(this.cache.set("providers_all", providers));

			await Promise.all(saves);
		} catch {
			// Cache write failure is non-fatal
		}
	}
}
