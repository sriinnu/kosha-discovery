/**
 * kosha-discovery — Thin registry façade.
 *
 * I keep `ModelRegistry` as the stable public API while the heavy lifting
 * lives in focused helper modules that stay under the file-size policy.
 * @module
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { normalizeProviderId } from "./provider-catalog.js";
import { normalizeModelId } from "./normalize.js";
import {
	registryBuildSnapshot,
	registryClassifyError,
	registryDiscoveryDelta,
	registryDiscoverySnapshot,
	registryMakeCursor,
	registryRecordDiscoveryMutation,
	registryRecordObservation,
	registrySnapshotForDelta,
	registryWatchDiscovery,
} from "./registry-discovery.js";
import {
	modelRoles,
	modelSupportsRole,
	normalizeRoleToken,
	registryCapabilities,
	registryCheapestModels,
	registryMissingCredentialPrompts,
	registryModelRouteInfo,
	registryModelRoutes,
	registryModels,
	registryProviderRoles,
} from "./registry-query.js";
import {
	registryCheapestCandidates,
	registryExecutionBindingHints,
} from "./registry-selection.js";
import { createRegistryState } from "./registry-state.js";
import type { ProviderObservation, RegistryState, DiscoveryDependencies } from "./registry-state.js";
import {
	enrichRegistryModels,
	registryEnrichOnly,
	type EnrichOnlyResult,
	fallbackRegistryCredential,
	getRegistryCredentialResolver,
	loadRegistryDiscoverers,
	loadRegistryFromCache,
	populateRegistryModelAliases,
	registryDiscover,
	registryRefresh,
	saveRegistryToCache,
} from "./registry-runtime.js";
import type {
	DiscoveryBindingHintsV1,
	DiscoveryBindingQuery,
	DiscoveryCheapestResultV1,
	DiscoveryDeltaV1,
	DiscoverySnapshotV1,
} from "./discovery-contract.js";
import type { ProviderHealth } from "./resilience.js";
import type {
	CapabilitySummary,
	CheapestModelOptions,
	CheapestModelResult,
	CredentialResult,
	DiscoveryError,
	DiscoveryOptions,
	KoshaConfig,
	LatestDiscoveryOptions,
	LatestDiscoveryResult,
	ModelCard,
	ModelMode,
	ModelRouteInfo,
	ProviderCredentialPrompt,
	ProviderInfo,
	ProviderRoleInfo,
	RoleQueryOptions,
} from "./types.js";

/**
 * Public registry API for provider discovery and routing-oriented queries.
 */
export class ModelRegistry {
	private readonly state: RegistryState;

	constructor(config?: KoshaConfig) {
		this.state = createRegistryState(config);
		this.currentCursor = registryMakeCursor(this.state);
	}

	/** Compatibility accessor retained for existing tests and debug hooks. */
	private get providerMap(): Map<string, ProviderInfo> { return this.state.providerMap; }
	/** Compatibility accessor retained for existing tests and debug hooks. */
	private get aliasResolver() { return this.state.aliasResolver; }
	/** Compatibility accessor retained for existing tests and debug hooks. */
	private get discoveredAt(): number { return this.state.discoveredAt; }
	private set discoveredAt(value: number) { this.state.discoveredAt = value; }
	/** Compatibility accessor retained for existing tests and debug hooks. */
	private get healthTracker() { return this.state.healthTracker; }
	private get currentCursor(): string { return this.state.currentCursor; }
	private set currentCursor(value: string) { this.state.currentCursor = value; }
	private get lastSnapshotCache(): DiscoverySnapshotV1 | null { return this.state.lastSnapshotCache; }
	private set lastSnapshotCache(value: DiscoverySnapshotV1 | null) { this.state.lastSnapshotCache = value; }

	/**
	 * Run discovery across all or selected providers.
	 */
	async discover(options?: DiscoveryOptions): Promise<ProviderInfo[]> {
		const credentialResolver = await getRegistryCredentialResolver();
		return registryDiscover(this.state, this.dependencies(credentialResolver), options);
	}

	/**
	 * Force a fresh discovery pass, bypassing cache for the targeted scope.
	 */
	async refresh(providerId?: string): Promise<void> {
		await registryRefresh(this.state, (options) => this.discover(options), providerId);
	}

	/**
	 * Force a live discovery fetch and return a summary payload.
	 *
	 * This always bypasses cache, so callers can ask for "latest now"
	 * without relying on TTL expiry.
	 */
	async fetchLatestDetails(options?: LatestDiscoveryOptions): Promise<LatestDiscoveryResult> {
		const providers = await this.discover({ ...options, force: true });
		return {
			providers,
			modelCount: providers.reduce((sum, provider) => sum + provider.models.length, 0),
			discoveredAt: this.discoveredAt,
		};
	}

	/**
	 * Re-run LiteLLM enrichment on cached models without re-discovering providers.
	 *
	 * This is the lightweight alternative to `refresh()` — no provider API calls,
	 * just a fetch from the litellm community catalogue. Returns `null` when
	 * no cached data is available (user should run `discover()` first).
	 */
	async enrichOnly(): Promise<EnrichOnlyResult | null> {
		return registryEnrichOnly(this.state);
	}

	/** Return all known models with optional provider/origin/mode filters. */
	models(filter?: { provider?: string; originProvider?: string; mode?: ModelMode; capability?: string }): ModelCard[] {
		return registryModels(this.state, filter);
	}

	/** Return the provider -> model -> roles matrix used by routing clients. */
	providerRoles(filter?: RoleQueryOptions): ProviderRoleInfo[] {
		return registryProviderRoles(this.state, filter);
	}

	/** Return prompts for discovered providers missing required credentials. */
	missingCredentialPrompts(providerIds?: string[]): ProviderCredentialPrompt[] {
		return registryMissingCredentialPrompts(this.state, providerIds);
	}

	/** Return the cheapest ranked legacy candidates for the requested query. */
	cheapestModels(options?: CheapestModelOptions): CheapestModelResult {
		return registryCheapestModels(this.state, options);
	}

	/** Return every provider route for a normalized model identifier. */
	modelRoutes(modelId: string): ModelCard[] {
		return registryModelRoutes(this.state, modelId);
	}

	/** Return enriched route metadata for a normalized model identifier. */
	modelRouteInfo(modelId: string): ModelRouteInfo[] {
		return registryModelRouteInfo(this.state, modelId);
	}

	/** Resolve a model by canonical ID or configured alias. */
	model(idOrAlias: string): ModelCard | undefined {
		const resolvedId = this.aliasResolver.resolve(idOrAlias);
		const models = registryModels(this.state);

		// 1) Exact canonical/alias-resolved ID.
		const exact = models.find((model) => model.id === resolvedId);
		if (exact) return exact;

		// 2) Normalized ID fallback (prefix/date/tag-insensitive).
		const targetNormalized = normalizeModelId(resolvedId).toLowerCase();
		const normalizedMatch = models.find((model) => normalizeModelId(model.id).toLowerCase() === targetNormalized);
		if (normalizedMatch) return normalizedMatch;

		// 3) Loose fallback for punctuation variants (dot/hyphen/underscore).
		const targetLoose = toLooseLookupKey(targetNormalized);
		return models.find((model) => toLooseLookupKey(normalizeModelId(model.id).toLowerCase()) === targetLoose);
	}

	/** Return a single provider by canonical or alias provider ID. */
	provider(id: string): ProviderInfo | undefined {
		const normalizedProviderId = normalizeProviderId(id) ?? id;
		return this.providerMap.get(normalizedProviderId);
	}

	/** Return all currently known providers. */
	providers_list(): ProviderInfo[] {
		return Array.from(this.providerMap.values());
	}

	/** Return errors captured during the most recent discovery pass. */
	discoveryErrors(): DiscoveryError[] {
		return [...this.state.lastDiscoveryErrors];
	}

	/** Return raw circuit-breaker health details for monitoring/debugging. */
	providerHealth(): ProviderHealth[] {
		return this.healthTracker.healthReport();
	}

	/** Build the stable v1 discovery snapshot for daemon consumers. */
	discoverySnapshot(): DiscoverySnapshotV1 {
		return registryDiscoverySnapshot(this.state);
	}

	/** Return delta batches since the provided cursor. */
	discoveryDelta(options?: { sinceCursor?: string | null }): DiscoveryDeltaV1 {
		return registryDiscoveryDelta(this.state, options);
	}

	/** Stream live discovery deltas through an async iterator. */
	watchDiscovery(options?: { sinceCursor?: string | null }): AsyncGenerator<DiscoveryDeltaV1, void, void> {
		return registryWatchDiscovery(this.state, options);
	}

	/** Return cheapest candidates using the trusted v1 capability taxonomy. */
	cheapestCandidates(query: DiscoveryBindingQuery = {}): DiscoveryCheapestResultV1 {
		return registryCheapestCandidates(this.state, query);
	}

	/** Return query-scoped binding hints without taking routing authority. */
	executionBindingHints(query: DiscoveryBindingQuery = {}): DiscoveryBindingHintsV1 {
		return registryExecutionBindingHints(this.state, query);
	}

	/** Reset one provider breaker or the full health tracker. */
	resetHealth(providerId?: string): void {
		if (providerId) {
			this.healthTracker.breaker(normalizeProviderId(providerId) ?? providerId).reset();
			return;
		}
		this.healthTracker.resetAll();
	}

	/** Aggregate capability statistics across the current model set. */
	capabilities(filter?: { provider?: string }): CapabilitySummary[] {
		return registryCapabilities(this.state, filter);
	}

	/** Normalize a role or capability token used by legacy queries. */
	normalizeRoleToken(value: string): string {
		return normalizeRoleToken(value);
	}

	/** Return the deduplicated role list for a model. */
	modelRoles(model: ModelCard): string[] {
		return modelRoles(model);
	}

	/** Check whether a model satisfies a role or capability query. */
	modelSupportsRole(model: ModelCard, roleOrCapability: string): boolean {
		return modelSupportsRole(model, roleOrCapability);
	}

	/** Resolve a configured alias to its canonical model ID. */
	resolve(alias: string): string {
		return this.aliasResolver.resolve(alias);
	}

	/** Add a custom alias mapping. */
	alias(short: string, modelId: string): void {
		this.aliasResolver.addAlias(short, modelId);
	}

	/** Serialize the registry into a plain JSON-compatible snapshot. */
	toJSON(): { providers: ProviderInfo[]; aliases: Record<string, string>; discoveredAt: number } {
		return {
			providers: this.providers_list(),
			aliases: this.aliasResolver.all(),
			discoveredAt: this.discoveredAt,
		};
	}

	/** Restore a registry instance from a serialized JSON payload. */
	static fromJSON(data: { providers: ProviderInfo[]; aliases: Record<string, string>; discoveredAt: number }): ModelRegistry {
		const registry = new ModelRegistry({ aliases: data.aliases });
		for (const provider of data.providers) {
			registry.providerMap.set(provider.id, provider);
		}
		registry.discoveredAt = data.discoveredAt;
		registry.currentCursor = registryMakeCursor(registry.state);
		registry.lastSnapshotCache = registryBuildSnapshot(registry.state, registry.currentCursor);
		return registry;
	}

	/** Load config from global/project files and merge explicit overrides last. */
	static async loadConfigFile(overrides?: KoshaConfig): Promise<KoshaConfig> {
		const layers: KoshaConfig[] = [];
		const globalConfig = await ModelRegistry.readJsonFile<KoshaConfig>(join(homedir(), ".kosharc.json"));
		const projectConfig = await ModelRegistry.readJsonFile<KoshaConfig>(join(process.cwd(), "kosha.config.json"));

		if (globalConfig) layers.push(globalConfig);
		if (projectConfig) layers.push(projectConfig);
		if (overrides) layers.push(overrides);
		if (layers.length === 0) return {};

		// I only deep-merge the provider and alias maps; the rest stays shallow.
		return layers.reduce<KoshaConfig>((merged, layer) => ({
			...merged,
			...layer,
			providers: { ...merged.providers, ...layer.providers },
			aliases: { ...merged.aliases, ...layer.aliases },
		}), {});
	}

	private dependencies(
		credentialResolver: { resolve: (providerId: string, explicitKey?: string) => Promise<CredentialResult> } | null,
	): DiscoveryDependencies {
		return {
			// I bind the loaded resolver once per discovery pass to avoid repeated dynamic imports.
			resolveCredential: credentialResolver ? (providerId, explicitKey) => credentialResolver.resolve(providerId, explicitKey) : null,
			loadDiscoverers: (providerIds, includeLocal) => loadRegistryDiscoverers(this.state, providerIds, includeLocal),
			enrichModels: () => enrichRegistryModels(this.state),
			populateModelAliases: () => populateRegistryModelAliases(this.state),
			loadFromCache: (providerIds) => loadRegistryFromCache(this.state, providerIds),
			saveToCache: () => saveRegistryToCache(this.state),
			fallbackCredential: fallbackRegistryCredential,
			snapshotForDelta: () => registrySnapshotForDelta(this.state),
			recordDiscoveryMutation: (previousSnapshot) => registryRecordDiscoveryMutation(this.state, previousSnapshot),
			recordObservation: (providerId, entry) => registryRecordObservation(this.state, providerId, entry),
			classifyError: (errorMessage) => registryClassifyError(errorMessage),
		};
	}

	/** Compatibility wrapper retained for tests that probe internal mutation APIs. */
	private snapshotForDelta(): DiscoverySnapshotV1 | null {
		return registrySnapshotForDelta(this.state);
	}

	/** Compatibility wrapper retained for tests that probe internal mutation APIs. */
	private recordDiscoveryMutation(previousSnapshot: DiscoverySnapshotV1 | null): void {
		return registryRecordDiscoveryMutation(this.state, previousSnapshot);
	}

	/** Compatibility wrapper retained for tests that probe internal mutation APIs. */
	private recordObservation(
		providerId: string,
		entry: { latencyMs: number; errorType: ProviderObservation["lastErrorType"] },
	): void {
		return registryRecordObservation(this.state, providerId, entry);
	}

	/** Compatibility wrapper retained for internal error classification hooks. */
	private classifyError(errorMessage: string): ProviderObservation["lastErrorType"] {
		return registryClassifyError(errorMessage);
	}

	private static async readJsonFile<T>(filePath: string): Promise<T | null> {
		try {
			return JSON.parse(await readFile(filePath, "utf-8")) as T;
		} catch (error: unknown) {
			if (error instanceof SyntaxError) {
				console.warn(`kosha: config file has invalid JSON: ${filePath}`);
			}
			return null;
		}
	}
}

function toLooseLookupKey(value: string): string {
	return value.replace(/[._-]+/g, "");
}
