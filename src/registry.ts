/**
 * kosha-discovery — ModelRegistry: the heart of kosha.
 *
 * Orchestrates provider discovery, credential resolution, enrichment,
 * caching, and querying into a single, easy-to-use registry class.
 * @module
 */

import type {
	CapabilitySummary,
	CheapestModelMatch,
	CheapestModelOptions,
	CheapestModelResult,
	CredentialResult,
	DiscoveryError,
	DiscoveryOptions,
	Enricher,
	KoshaConfig,
	ModelCard,
	ModelMode,
	ModelRouteInfo,
	PricingMetric,
	ProviderCredentialPrompt,
	ProviderDiscoverer,
	ProviderInfo,
	ProviderRoleInfo,
	RoleQueryOptions,
} from "./types.js";
import { EventEmitter } from "node:events";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { AliasResolver } from "./aliases.js";
import { KoshaCache } from "./cache.js";
import type {
	DiscoveryBindingHintsV1,
	DiscoveryBindingQuery,
	DiscoveryChangeV1,
	DiscoveryCheapestResultV1,
	DiscoveryDeltaV1,
	DiscoveryHealthRecord,
	DiscoveryModelV1,
	DiscoveryProviderV1,
	DiscoverySnapshotV1,
	TrustedCapability,
} from "./discovery-contract.js";
import {
	DISCOVERY_SCHEMA_VERSION,
	discoveryRoles,
	makeModelKey,
	rawCapabilitiesForModel,
	trustedCapabilitiesForModel,
} from "./discovery-contract.js";
import { extractModelVersion, extractOriginProvider, normalizeModelId } from "./normalize.js";
import {
	getProviderConfig,
	getProviderDescriptor,
	isLocalProvider,
	listProviderDescriptors,
	normalizeProviderId,
} from "./provider-catalog.js";
import { HealthTracker, StaleCachePolicy } from "./resilience.js";
import type { ProviderHealth } from "./resilience.js";

const DEFAULT_CACHE_TTL_MS = 86_400_000; // 24 hours
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_KEY_PREFIX = "provider_";

const ROLE_ALIASES: Record<string, string> = {
	embeddings: "embedding",
	vector: "embedding",
	vectors: "embedding",
	images: "image_generation",
	imagegen: "image_generation",
	image_generation: "image_generation",
	image_generation_model: "image_generation",
	stt: "speech_to_text",
	transcription: "speech_to_text",
	tts: "text_to_speech",
	speech: "audio",
	tool_use: "function_calling",
	tools: "function_calling",
	functions: "function_calling",
	functioncalling: "function_calling",
	prompt_cache: "prompt_caching",
};

const MODE_ALIASES: Record<string, ModelMode> = {
	chat: "chat",
	completion: "chat",
	completions: "chat",
	embedding: "embedding",
	image: "image",
	image_generation: "image",
	audio: "audio",
	speech_to_text: "audio",
	text_to_speech: "audio",
	moderation: "moderation",
	safety: "moderation",
};

interface ProviderObservation {
	latenciesMs: number[];
	timeoutCount: number;
	attemptCount: number;
	lastErrorType: "auth_error" | "throttled" | "timeout" | "transport" | "unknown" | null;
}

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
	private lastDiscoveryErrors: DiscoveryError[] = [];
	private healthTracker = new HealthTracker();
	private providerObservations = new Map<string, ProviderObservation>();
	private discoveryEventBus = new EventEmitter();
	private discoveryRevision = 0;
	private currentCursor = this.makeCursor();
	private lastSnapshotCache: DiscoverySnapshotV1 | null = null;
	private deltaHistory: DiscoveryDeltaV1[] = [];

	constructor(config?: KoshaConfig) {
		this.config = config ?? {};
		this.aliasResolver = new AliasResolver(this.config.aliases);
		this.cache = new KoshaCache(this.config.cacheDir);
		this.discoveryEventBus.setMaxListeners(0);
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
		const beforeSnapshot = this.snapshotForDelta();
		const providers = options?.providers?.map((providerId) => normalizeProviderId(providerId) ?? providerId);
		const force = options?.force ?? false;

		// Try loading from cache first (unless forced)
		if (!force) {
			const loaded = await this.loadFromCache(providers);
			if (loaded) {
				this.recordDiscoveryMutation(beforeSnapshot);
				return this.providers_list();
			}
		}

		const discoverers = await this.loadDiscoverers(providers, options?.includeLocal);
		const credentialResolver = await this.getCredentialResolver();
		const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

		// Run discovery in parallel — one failing provider does not block others.
		// Circuit breakers skip providers that are consistently failing.
		const results = await Promise.allSettled(
			discoverers.map(async (discoverer) => {
				const breaker = this.healthTracker.breaker(discoverer.providerId);
				const startedAt = Date.now();

				// Circuit breaker: skip providers in open state, serve stale cache instead
				if (!breaker.canExecute()) {
					const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
						this.cache,
						`${CACHE_KEY_PREFIX}${discoverer.providerId}`,
					);
					if (stale) {
						return stale.data;
					}
					// No stale data — skip this provider entirely
					return null;
				}

				const explicitKey = getProviderConfig(this.config, discoverer.providerId)?.apiKey;
				const credential = credentialResolver
					? await credentialResolver.resolve(discoverer.providerId, explicitKey)
					: this.fallbackCredential(discoverer.providerId, explicitKey);

				try {
					const models = await discoverer.discover(credential, { timeout });
					breaker.onSuccess();
					this.recordObservation(discoverer.providerId, {
						latencyMs: Date.now() - startedAt,
						errorType: null,
					});

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
				} catch (error: unknown) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					breaker.onFailure(errorMsg);
					this.recordObservation(discoverer.providerId, {
						latencyMs: Date.now() - startedAt,
						errorType: this.classifyError(errorMsg),
					});

					// Degrade gracefully: serve stale cached data for this provider
					const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
						this.cache,
						`${CACHE_KEY_PREFIX}${discoverer.providerId}`,
					);
					if (stale) {
						return stale.data;
					}

					// No stale fallback — propagate the error
					throw error;
				}
			}),
		);

		// Collect successful results and record failures
		this.lastDiscoveryErrors = [];
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (result.status === "fulfilled") {
				if (result.value !== null) {
					this.providerMap.set(result.value.id, result.value);
				}
			} else {
				const discoverer = discoverers[i];
				this.lastDiscoveryErrors.push({
					providerId: discoverer.providerId,
					providerName: discoverer.providerName,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
					timestamp: Date.now(),
				});
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
		this.recordDiscoveryMutation(beforeSnapshot);

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
	 * Return all known models, optionally filtered by provider, originProvider, mode, or capability.
	 *
	 * Deduplication is provider-aware: the same underlying model served through
	 * different providers (e.g. `claude-opus-4-6` via anthropic, openrouter, and
	 * bedrock) is **kept** as separate entries because each represents a distinct
	 * route. Only exact `{provider}:{id}` duplicates within the same provider are
	 * collapsed.
	 *
	 * @param filter - Optional filter criteria. All supplied fields are ANDed.
	 * @param filter.provider       - Limit to a specific serving-layer provider ID.
	 * @param filter.originProvider - Limit to models whose creator matches this slug
	 *                                (e.g. `"anthropic"` returns Claude models from
	 *                                any serving provider).
	 * @param filter.mode           - Limit to a specific {@link ModelMode}.
	 * @param filter.capability     - Limit to models that declare this capability string.
	 */
	models(filter?: {
		provider?: string;
		originProvider?: string;
		mode?: ModelMode;
		capability?: string;
	}): ModelCard[] {
		// Use composite key so the same base model served by different providers
		// is not incorrectly collapsed into one entry.
		const seen = new Set<string>();
		const result: ModelCard[] = [];

		const normalizedProvider = normalizeProviderId(filter?.provider);
		const normalizedOriginProvider = normalizeProviderId(filter?.originProvider);

		for (const providerInfo of this.providerMap.values()) {
			if (normalizedProvider && providerInfo.id !== normalizedProvider) {
				continue;
			}

			for (const model of providerInfo.models) {
				// Provider-aware dedup key prevents collapsing cross-provider routes.
				const dedupKey = `${model.provider}:${model.id}`;
				if (seen.has(dedupKey)) continue;

				if (normalizedOriginProvider && normalizeProviderId(model.originProvider) !== normalizedOriginProvider) continue;
				if (filter?.mode && model.mode !== filter.mode) continue;
				if (filter?.capability && !model.capabilities.includes(filter.capability)) continue;

				seen.add(dedupKey);
				result.push(model);
			}
		}

		return result;
	}

	/**
	 * Return a provider -> models -> roles matrix suitable for assistant routing.
	 *
	 * Roles are derived from `mode + capabilities` so consumers can ask for
	 * high-level intents like "embeddings" or "image generation".
	 */
	providerRoles(filter?: RoleQueryOptions): ProviderRoleInfo[] {
		const normalizedCapability = filter?.capability ? this.normalizeRoleToken(filter.capability) : undefined;
		const normalizedProvider = normalizeProviderId(filter?.provider);
		const normalizedOriginProvider = normalizeProviderId(filter?.originProvider);
		const providers: ProviderRoleInfo[] = [];

		for (const providerInfo of this.providerMap.values()) {
			if (normalizedProvider && providerInfo.id !== normalizedProvider) {
				continue;
			}

			const models = providerInfo.models.filter((model) => {
				if (normalizedOriginProvider && normalizeProviderId(model.originProvider) !== normalizedOriginProvider) return false;
				if (filter?.mode && model.mode !== filter.mode) return false;
				if (normalizedCapability && !this.modelSupportsRole(model, normalizedCapability)) return false;
				if (filter?.role && !this.modelSupportsRole(model, filter.role)) return false;
				return true;
			}).map((model) => ({
				id: model.id,
				name: model.name,
				provider: model.provider,
				originProvider: model.originProvider,
				mode: model.mode,
				roles: this.modelRoles(model),
				pricing: model.pricing,
			}));

			if (models.length === 0) continue;

			providers.push({
				id: providerInfo.id,
				name: providerInfo.name,
				authenticated: providerInfo.authenticated,
				credentialSource: providerInfo.credentialSource,
				models,
			});
		}

		providers.sort((a, b) => a.id.localeCompare(b.id));
		for (const provider of providers) {
			provider.models.sort((a, b) => a.id.localeCompare(b.id));
		}

		return providers;
	}

	/**
	 * Return prompt metadata for providers that are currently missing required
	 * credentials (API keys, cloud auth config, etc.).
	 */
		missingCredentialPrompts(providerIds?: string[]): ProviderCredentialPrompt[] {
		const prompts: ProviderCredentialPrompt[] = [];
		const normalizedIds = providerIds?.map((providerId) => normalizeProviderId(providerId) ?? providerId);
		const providers = providerIds && providerIds.length > 0
			? normalizedIds?.reduce<ProviderInfo[]>((items, providerId) => {
				const provider = this.provider(providerId ?? "");
				if (provider) items.push(provider);
				return items;
			}, []) ?? []
			: this.providers_list();

		for (const provider of providers) {
			const descriptor = this.providerDescriptor(provider.id, provider);
			if (normalizedIds && normalizedIds.length > 0 && !normalizedIds.includes(descriptor.providerId)) {
				continue;
			}
			if (!descriptor.credentialRequired) {
				continue;
			}
			if (provider.authenticated) {
				continue;
			}

			const envHint = descriptor.credentialEnvVars.length > 0
				? `Set ${descriptor.credentialEnvVars.join(" or ")}`
				: "Configure credentials";

			prompts.push({
				providerId: descriptor.providerId,
				providerName: descriptor.name,
				required: true,
				envVars: descriptor.credentialEnvVars,
				message: `${envHint} to enable ${descriptor.name} model discovery.`,
			});
		}

		prompts.sort((a, b) => a.providerId.localeCompare(b.providerId));
		return prompts;
	}

	/**
	 * Return a ranked list of cheapest models for the requested role/mode.
	 *
	 * Models missing pricing are excluded by default so callers can safely route
	 * without accidentally treating unknown prices as zero-cost.
	 */
	cheapestModels(options?: CheapestModelOptions): CheapestModelResult {
		const filters = {
			provider: options?.provider,
			originProvider: options?.originProvider,
			mode: options?.mode,
		};
		const role = options?.role;
		const capability = options?.capability ? this.normalizeRoleToken(options.capability) : undefined;
		const includeUnpriced = options?.includeUnpriced ?? false;
		const limit = this.normalizeLimit(options?.limit);

		const candidates = this.models(filters).filter((model) => {
			if (capability && !this.modelSupportsRole(model, capability)) return false;
			if (!role) return true;
			return this.modelSupportsRole(model, role);
		});

		const priceMetric = options?.priceMetric ?? this.defaultPricingMetric(options);
		const inputWeight = options?.inputWeight ?? 1;
		const outputWeight = options?.outputWeight ?? 1;

		const ranked: CheapestModelMatch[] = [];
		const unpriced: CheapestModelMatch[] = [];

		for (const model of candidates) {
			const score = this.computeModelScore(model, priceMetric, inputWeight, outputWeight);
			if (score === undefined) {
				if (includeUnpriced) {
					unpriced.push({ model, score: undefined, priceMetric });
				}
				continue;
			}
			ranked.push({ model, score, priceMetric });
		}

		ranked.sort((a, b) => {
			const aScore = a.score ?? Number.POSITIVE_INFINITY;
			const bScore = b.score ?? Number.POSITIVE_INFINITY;
			if (aScore !== bScore) return aScore - bScore;
			const providerOrder = a.model.provider.localeCompare(b.model.provider);
			if (providerOrder !== 0) return providerOrder;
			return a.model.id.localeCompare(b.model.id);
		});

		unpriced.sort((a, b) => {
			const providerOrder = a.model.provider.localeCompare(b.model.provider);
			if (providerOrder !== 0) return providerOrder;
			return a.model.id.localeCompare(b.model.id);
		});

		const matches = [...ranked, ...unpriced].slice(0, limit);
		const scopedProviderIds = options?.provider
			? [options.provider]
			: this.providers_list().map((provider) => provider.id);

		return {
			matches,
			candidates: candidates.length,
			pricedCandidates: ranked.length,
			skippedNoPricing: candidates.length - ranked.length,
			priceMetric,
			missingCredentials: this.missingCredentialPrompts(scopedProviderIds),
		};
	}

	/**
	 * Find all provider routes through which a given model can be accessed.
	 *
	 * A "route" is a {@link ModelCard} whose normalized model ID matches the
	 * normalized form of `modelId`. This lets callers discover every serving
	 * provider (anthropic direct, openrouter, bedrock, vertex, …) for a single
	 * underlying model in one call.
	 *
	 * Normalization strips provider prefixes and calendar-date version suffixes
	 * so that `"claude-opus-4-6"`, `"anthropic/claude-opus-4-6"`, and
	 * `"anthropic.claude-opus-4-6-20250514-v1:0"` all compare as equal.
	 *
	 * Results are sorted by provider name for deterministic output.
	 *
	 * @param modelId - Any form of model identifier (namespaced, versioned, bare).
	 * @returns All {@link ModelCard}s that represent the same underlying model
	 *          across all discovered providers.
	 *
	 * @example
	 * registry.modelRoutes("claude-opus-4-6")
	 * // Returns cards from: anthropic (direct), openrouter, bedrock
	 *
	 * @example
	 * registry.modelRoutes("gpt-4o-2024-11-20")
	 * // Returns cards from: openai (direct), azure, openrouter
	 */
	modelRoutes(modelId: string): ModelCard[] {
		const targetNorm = normalizeModelId(modelId).toLowerCase();
		const routes: ModelCard[] = [];

		for (const providerInfo of this.providerMap.values()) {
			for (const model of providerInfo.models) {
				const candidateNorm = normalizeModelId(model.id).toLowerCase();
				if (candidateNorm === targetNorm) {
					routes.push(model);
				}
			}
		}

		// Sort by provider for deterministic, human-friendly output.
		routes.sort((a, b) => a.provider.localeCompare(b.provider));

		return routes;
	}

	/**
	 * Return enriched route metadata including direct/preferred flags, provider
	 * base URLs, and version hints for each serving path.
	 */
	modelRouteInfo(modelId: string): ModelRouteInfo[] {
		const routes = this.modelRoutes(modelId);
		if (routes.length === 0) return [];

		const info: ModelRouteInfo[] = routes.map((model) => {
			const resolvedOrigin = model.originProvider ?? extractOriginProvider(model.id) ?? model.provider;
			const providerInfo = this.provider(model.provider);
			return {
				model,
				provider: model.provider,
				originProvider: resolvedOrigin,
				baseUrl: providerInfo?.baseUrl,
				version: extractModelVersion(model.id),
				isDirect: model.provider === resolvedOrigin,
				isPreferred: false,
			};
		});

		// Prefer direct-origin routes whenever available.
		const directRoutes = info.filter((route) => route.isDirect);
		if (directRoutes.length > 0) {
			for (const route of directRoutes) {
				route.isPreferred = true;
			}
		} else {
			// Fall back to cheapest priced route, then deterministic lexical order.
			const priced = info.filter((route) =>
				route.model.pricing &&
				Number.isFinite(route.model.pricing.inputPerMillion) &&
				Number.isFinite(route.model.pricing.outputPerMillion),
			);
			if (priced.length > 0) {
				priced.sort((a, b) => {
					const aScore = (a.model.pricing?.inputPerMillion ?? 0) + (a.model.pricing?.outputPerMillion ?? 0);
					const bScore = (b.model.pricing?.inputPerMillion ?? 0) + (b.model.pricing?.outputPerMillion ?? 0);
					if (aScore !== bScore) return aScore - bScore;
					return a.provider.localeCompare(b.provider);
				});
				priced[0].isPreferred = true;
			} else {
				info[0].isPreferred = true;
			}
		}

		info.sort((a, b) => {
			if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
			if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
			return a.provider.localeCompare(b.provider);
		});

		return info;
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

		return undefined;
	}

	/**
	 * Get a single provider's info by ID.
	 */
	provider(id: string): ProviderInfo | undefined {
		const normalized = normalizeProviderId(id) ?? id;
		return this.providerMap.get(normalized);
	}

	/**
	 * List all known providers.
	 */
	providers_list(): ProviderInfo[] {
		return Array.from(this.providerMap.values());
	}

	/**
	 * Return errors from the most recent discovery pass.
	 *
	 * Each entry identifies a provider that failed and the error message.
	 * Empty when all providers succeeded or no discovery has been run yet.
	 */
	discoveryErrors(): DiscoveryError[] {
		return [...this.lastDiscoveryErrors];
	}

	/**
	 * Return health status for all tracked providers.
	 *
	 * Each entry contains the circuit breaker state (`closed`, `open`, `half-open`),
	 * failure counts, and last error messages. Useful for monitoring dashboards
	 * and deciding whether to trigger manual recovery.
	 */
	providerHealth(): ProviderHealth[] {
		return this.healthTracker.healthReport();
	}

	/**
	 * Build the stable v1 discovery snapshot for daemon consumers.
	 */
	discoverySnapshot(): DiscoverySnapshotV1 {
		const snapshot = this.buildSnapshot(this.currentCursor);
		this.lastSnapshotCache = snapshot;
		return snapshot;
	}

	/**
	 * Return aggregated deltas since a prior cursor.
	 *
	 * Passing no cursor returns a full "upsert everything" delta so polling
	 * clients can bootstrap from the delta surface alone.
	 */
	discoveryDelta(options?: { sinceCursor?: string | null }): DiscoveryDeltaV1 {
		const snapshot = this.discoverySnapshot();
		const sinceCursor = options?.sinceCursor ?? null;

		if (!sinceCursor) {
			return {
				schemaVersion: DISCOVERY_SCHEMA_VERSION,
				sinceCursor,
				cursor: snapshot.cursor,
				changedAt: snapshot.discoveredAt,
				resetRequired: false,
				changes: this.fullSnapshotChanges(snapshot),
			};
		}

		if (sinceCursor === snapshot.cursor) {
			return {
				schemaVersion: DISCOVERY_SCHEMA_VERSION,
				sinceCursor,
				cursor: snapshot.cursor,
				changedAt: snapshot.discoveredAt,
				resetRequired: false,
				changes: [],
			};
		}

		const sinceIndex = this.deltaHistory.findIndex((delta) =>
			delta.sinceCursor === sinceCursor || delta.cursor === sinceCursor
		);
		if (sinceIndex === -1) {
			return {
				schemaVersion: DISCOVERY_SCHEMA_VERSION,
				sinceCursor,
				cursor: snapshot.cursor,
				changedAt: snapshot.discoveredAt,
				resetRequired: true,
				changes: [],
			};
		}

		const deltas = this.deltaHistory.slice(sinceIndex);
		return {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			sinceCursor,
			cursor: snapshot.cursor,
			changedAt: deltas.at(-1)?.changedAt ?? snapshot.discoveredAt,
			resetRequired: false,
			changes: deltas.flatMap((delta) => delta.changes),
		};
	}

	/**
	 * Watch live discovery deltas as an async iterator.
	 */
	async *watchDiscovery(options?: { sinceCursor?: string | null }): AsyncGenerator<DiscoveryDeltaV1, void, void> {
		const backlog = this.discoveryDelta({ sinceCursor: options?.sinceCursor ?? null });
		if (backlog.resetRequired || backlog.changes.length > 0) {
			yield backlog;
		}

		const queue: DiscoveryDeltaV1[] = [];
		let notify: (() => void) | undefined;
		const listener = (delta: DiscoveryDeltaV1) => {
			queue.push(delta);
			notify?.();
			notify = undefined;
		};

		this.discoveryEventBus.on("delta", listener);
		try {
			while (true) {
				if (queue.length === 0) {
					await new Promise<void>((resolve) => {
						notify = resolve;
					});
				}
				const next = queue.shift();
				if (next) yield next;
			}
		} finally {
			this.discoveryEventBus.off("delta", listener);
		}
	}

	/**
	 * Return ranked cheapest candidates using the trusted v1 capability filters.
	 */
	cheapestCandidates(query: DiscoveryBindingQuery = {}): DiscoveryCheapestResultV1 {
		const candidates = this.discoveryCandidateModels(query);
		const priceMetric = query.priceMetric ?? this.defaultPricingMetric({
			mode: query.mode as ModelMode | undefined,
			role: query.role,
			capability: query.capability,
		});
		const inputWeight = 1;
		const outputWeight = 1;
		const ranked = candidates.map(({ model, descriptor }) => ({
			model,
			descriptor,
			score: this.computeModelScore(model, priceMetric as PricingMetric, inputWeight, outputWeight),
		}));

		const priced = ranked.filter((entry) => entry.score !== undefined);
		const unpriced = ranked.filter((entry) => entry.score === undefined);

		priced.sort((a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY));

		const limit = this.normalizeLimit(query.limit);
		const matches = [...priced, ...unpriced].slice(0, limit).map(({ model, descriptor, score }) => ({
			modelId: model.id,
			providerId: model.provider,
			canonicalProviderId: descriptor.canonicalProviderId,
			score: score ?? null,
			priceMetric,
			capabilities: trustedCapabilitiesForModel(model, descriptor),
		}));

		return {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			query: this.discoveryQueryRecord(query),
			candidates: candidates.length,
			pricedCandidates: priced.length,
			skippedNoPricing: candidates.length - priced.length,
			priceMetric,
			matches,
		};
	}

	/**
	 * Return query-scoped discovery hints that Chitragupta can turn into a binding.
	 */
	executionBindingHints(query: DiscoveryBindingQuery = {}): DiscoveryBindingHintsV1 {
		const preferLocalProviders = query.preferLocalProviders ?? false;
		const allowCrossProvider = query.allowCrossProvider ?? true;
		const routes = this.discoveryCandidateModels(query)
			.map(({ model, descriptor }) => ({
				model,
				descriptor,
				capabilities: trustedCapabilitiesForModel(model, descriptor),
				isLocal: descriptor.isLocal,
				isDirect: normalizeProviderId(model.originProvider) === descriptor.canonicalProviderId,
				price: this.computeModelScore(
					model,
					(query.priceMetric ?? this.defaultPricingMetric({
						mode: query.mode as ModelMode | undefined,
						role: query.role,
						capability: query.capability,
					})) as PricingMetric,
					1,
					1,
				),
			}))
			.sort((a, b) => {
				if (preferLocalProviders && a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
				if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
				const aPrice = a.price ?? Number.POSITIVE_INFINITY;
				const bPrice = b.price ?? Number.POSITIVE_INFINITY;
				if (aPrice !== bPrice) return aPrice - bPrice;
				if (a.descriptor.canonicalProviderId !== b.descriptor.canonicalProviderId) {
					return a.descriptor.canonicalProviderId.localeCompare(b.descriptor.canonicalProviderId);
				}
				return a.model.id.localeCompare(b.model.id);
			});

		const selected = routes[0];
		const scopedRoutes = !allowCrossProvider && selected
			? routes.filter((route) => route.model.provider === selected.model.provider)
			: routes;
		const limit = this.normalizeLimit(query.limit);
		const preferredRoutes = scopedRoutes.slice(0, limit);

		return {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			query: this.discoveryQueryRecord(query),
			selectedModelId: selected?.model.id ?? null,
			selectedProviderId: selected?.model.provider ?? null,
			candidateModelIds: Array.from(new Set(scopedRoutes.map((route) => route.model.id))),
			preferredModelIds: Array.from(new Set(preferredRoutes.map((route) => route.model.id))),
			preferredProviderIds: Array.from(new Set(preferredRoutes.map((route) => route.model.provider))),
			preferLocalProviders,
			allowCrossProvider,
		};
	}

	/**
	 * Reset the circuit breaker for a specific provider or all providers.
	 * Use this for manual recovery after a transient outage is resolved.
	 */
	resetHealth(providerId?: string): void {
		if (providerId) {
			this.healthTracker.breaker(providerId).reset();
		} else {
			this.healthTracker.resetAll();
		}
	}

	// ---------------------------------------------------------------------------
	// Capability aggregation
	// ---------------------------------------------------------------------------

	/**
	 * Aggregate capability statistics across all discovered models.
	 *
	 * Iterates every model, collects unique capabilities (using the same
	 * normalization as {@link providerRoles}), and returns per-capability
	 * counts of models, providers, and an example model ID.
	 *
	 * @param filter - Optional provider scope.
	 * @returns Sorted (by model count desc) list of capability summaries.
	 */
	capabilities(filter?: { provider?: string }): CapabilitySummary[] {
		const capMap = new Map<string, {
			models: Set<string>;
			providers: Set<string>;
			modes: Set<ModelMode>;
			exampleModelId?: string;
		}>();

		const allModels = this.models({ provider: filter?.provider });

		for (const model of allModels) {
			const roles = this.modelRoles(model);
			for (const role of roles) {
				let entry = capMap.get(role);
				if (!entry) {
					entry = { models: new Set(), providers: new Set(), modes: new Set(), exampleModelId: model.id };
					capMap.set(role, entry);
				}
				entry.models.add(`${model.provider}:${model.id}`);
				entry.providers.add(model.provider);
				entry.modes.add(model.mode);
			}
		}

		const result: CapabilitySummary[] = [];
		for (const [capability, entry] of capMap) {
			result.push({
				capability,
				modelCount: entry.models.size,
				providerCount: entry.providers.size,
				providers: Array.from(entry.providers).sort(),
				modes: Array.from(entry.modes).sort() as ModelMode[],
				exampleModelId: entry.exampleModelId,
			});
		}

		result.sort((a, b) => {
			if (a.modelCount !== b.modelCount) return b.modelCount - a.modelCount;
			return a.capability.localeCompare(b.capability);
		});

		return result;
	}

	// ---------------------------------------------------------------------------
	// Query helpers
	// ---------------------------------------------------------------------------

	/**
	 * Normalize a role/capability token by lowercasing, collapsing whitespace
	 * and hyphens to underscores, and resolving known aliases.
	 *
	 * @example
	 * registry.normalizeRoleToken("embeddings") // "embedding"
	 * registry.normalizeRoleToken("tool_use")   // "function_calling"
	 * registry.normalizeRoleToken("stt")         // "speech_to_text"
	 */
	normalizeRoleToken(value: string): string {
		const token = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
		return ROLE_ALIASES[token] ?? token;
	}

	/**
	 * Return the deduplicated set of roles for a model (mode + normalized capabilities).
	 */
	modelRoles(model: ModelCard): string[] {
		const roles = [model.mode, ...model.capabilities.map((capability) => this.normalizeRoleToken(capability))];
		return Array.from(new Set(roles));
	}

	/**
	 * Check whether a model supports the given role or capability.
	 * Normalizes the input and checks against mode, capabilities, and mode aliases.
	 */
	modelSupportsRole(model: ModelCard, roleOrCapability: string): boolean {
		const token = this.normalizeRoleToken(roleOrCapability);
		const modelRoles = this.modelRoles(model);
		if (modelRoles.includes(token)) return true;

		const mode = MODE_ALIASES[token];
		if (mode && model.mode === mode) return true;

		// Image mode models are eligible when asked for "image_generation".
		if (token === "image_generation" && model.mode === "image") return true;

		return false;
	}

	private defaultPricingMetric(options?: CheapestModelOptions): PricingMetric {
		const mode = options?.mode;
		const capability = options?.capability ? this.normalizeRoleToken(options.capability) : undefined;
		const role = options?.role ? this.normalizeRoleToken(options.role) : undefined;
		const effective = role ?? capability;

		if (mode === "embedding" || effective === "embedding") {
			return "input";
		}
		if (mode === "audio" && (effective === "speech_to_text" || effective === "text_to_speech")) {
			return "input";
		}
		return "blended";
	}

	private computeModelScore(
		model: ModelCard,
		metric: PricingMetric,
		inputWeight: number,
		outputWeight: number,
	): number | undefined {
		if (!model.pricing) return undefined;

		const input = model.pricing.inputPerMillion;
		const output = model.pricing.outputPerMillion;

		if (metric === "input") {
			return Number.isFinite(input) ? input : undefined;
		}
		if (metric === "output") {
			return Number.isFinite(output) ? output : undefined;
		}

		if (!Number.isFinite(input) || !Number.isFinite(output)) {
			return undefined;
		}
		return input * inputWeight + output * outputWeight;
	}

	private normalizeLimit(limit: number | undefined): number {
		if (limit === undefined) return 5;
		if (!Number.isFinite(limit)) return 5;
		const normalized = Math.floor(limit);
		if (normalized <= 0) return 1;
		return normalized;
	}

	private snapshotForDelta(): DiscoverySnapshotV1 | null {
		if (this.lastSnapshotCache) return this.lastSnapshotCache;
		if (this.providerMap.size === 0 && this.discoveredAt === 0) return null;
		return this.buildSnapshot(this.currentCursor);
	}

	private recordDiscoveryMutation(previousSnapshot: DiscoverySnapshotV1 | null): void {
		this.discoveryRevision += 1;
		this.currentCursor = this.makeCursor();
		const nextSnapshot = this.buildSnapshot(this.currentCursor);
		this.lastSnapshotCache = nextSnapshot;

		if (!previousSnapshot) {
			return;
		}

		const delta = this.diffSnapshots(previousSnapshot, nextSnapshot);
		if (delta.changes.length === 0) {
			return;
		}

		this.deltaHistory.push(delta);
		if (this.deltaHistory.length > 50) {
			this.deltaHistory.shift();
		}
		this.discoveryEventBus.emit("delta", delta);
	}

	private makeCursor(): string {
		return `discovery-${this.discoveryRevision}-${this.discoveredAt || Date.now()}`;
	}

	private buildSnapshot(cursor: string): DiscoverySnapshotV1 {
		const providers = listProviderDescriptors().map((descriptor) => this.serializeProvider(descriptor.providerId));
		const models = this.models()
			.map((model) => this.serializeModel(model))
			.sort((a, b) => a.key.localeCompare(b.key));
		const health = listProviderDescriptors()
			.map((descriptor) => this.buildHealthRecord(descriptor.providerId))
			.sort((a, b) => a.providerId.localeCompare(b.providerId));

		return {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			discoveredAt: this.discoveredAt || null,
			cursor,
			providers,
			models,
			roles: discoveryRoles(),
			health,
			credentialPrompts: this.catalogCredentialPrompts().map((prompt) => ({
				providerId: prompt.providerId,
				providerName: prompt.providerName,
				required: prompt.required,
				envVars: [...prompt.envVars],
				message: prompt.message,
			})),
		};
	}

	private catalogCredentialPrompts(): ProviderCredentialPrompt[] {
		const prompts: ProviderCredentialPrompt[] = [];

		for (const descriptor of listProviderDescriptors()) {
			const provider = this.providerMap.get(descriptor.providerId);
			if (!descriptor.credentialRequired || provider?.authenticated) {
				continue;
			}

			const envHint = descriptor.credentialEnvVars.length > 0
				? `Set ${descriptor.credentialEnvVars.join(" or ")}`
				: "Configure credentials";

			prompts.push({
				providerId: descriptor.providerId,
				providerName: descriptor.name,
				required: true,
				envVars: descriptor.credentialEnvVars,
				message: `${envHint} to enable ${descriptor.name} model discovery.`,
			});
		}

		return prompts.sort((a, b) => a.providerId.localeCompare(b.providerId));
	}

	private providerDescriptor(providerId: string, providerInfo?: ProviderInfo) {
		return getProviderDescriptor(providerId) ?? {
			providerId,
			canonicalProviderId: providerId,
			aliases: [],
			name: providerInfo?.name ?? providerId,
			origin: isLocalProvider(providerId) ? "local" : "direct",
			isLocal: isLocalProvider(providerId),
			transport: providerInfo?.baseUrl?.startsWith("http") ? "native-http" : "native-http",
			defaultBaseUrl: providerInfo?.baseUrl ?? "",
			credentialRequired: false,
			credentialEnvVars: [],
		};
	}

	private serializeProvider(providerId: string): DiscoveryProviderV1 {
		const provider = this.providerMap.get(providerId);
		const descriptor = this.providerDescriptor(providerId, provider);

		const config = getProviderConfig(this.config, providerId);
		return {
			providerId: descriptor.providerId,
			canonicalProviderId: descriptor.canonicalProviderId,
			aliases: [...descriptor.aliases],
			name: descriptor.name,
			origin: descriptor.origin,
			isLocal: descriptor.isLocal,
			transport: descriptor.transport,
			authenticated: provider?.authenticated ?? false,
			credentialSource: provider?.credentialSource ?? null,
			credentialsPresent: provider?.authenticated ?? false,
			credentialsRequired: descriptor.credentialRequired,
			credentialEnvVars: [...descriptor.credentialEnvVars],
			modelCount: provider?.models.length ?? 0,
			lastRefreshed: provider?.lastRefreshed ?? null,
			baseUrl: provider?.baseUrl ?? config?.baseUrl ?? descriptor.defaultBaseUrl,
		};
	}

	private serializeModel(model: ModelCard): DiscoveryModelV1 {
		const provider = this.providerMap.get(model.provider);
		const descriptor = this.providerDescriptor(model.provider, provider);

		const runtime = model.localRuntime;
		const capabilities = trustedCapabilitiesForModel(model, descriptor);
		return {
			key: makeModelKey(model, descriptor),
			modelId: model.id,
			name: model.name,
			providerId: model.provider,
			canonicalProviderId: descriptor.canonicalProviderId,
			originProviderId: normalizeProviderId(model.originProvider) ?? model.originProvider ?? descriptor.canonicalProviderId,
			mode: model.mode,
			capabilities,
			rawCapabilities: rawCapabilitiesForModel(model),
			contextWindow: model.contextWindow > 0 ? model.contextWindow : null,
			maxOutputTokens: model.maxOutputTokens > 0 ? model.maxOutputTokens : null,
			pricing: model.pricing ?? null,
			dimensions: model.dimensions ?? null,
			maxInputTokens: model.maxInputTokens ?? null,
			discoveredAt: model.discoveredAt,
			source: model.source,
			aliases: [...model.aliases],
			region: model.region ?? null,
			projectId: model.projectId ?? null,
			runtimeFamily: runtime?.runtimeFamily ?? (descriptor.isLocal ? descriptor.canonicalProviderId : null),
			tokenizerFamily: runtime?.tokenizerFamily ?? null,
			quantization: runtime?.quantization ?? null,
			memoryFootprintBytes: runtime?.memoryFootprintBytes ?? null,
			computeTarget: runtime?.computeTarget ?? null,
			supportsStructuredOutput: runtime?.supportsStructuredOutput ?? null,
			supportsStreaming: runtime?.supportsStreaming ?? null,
		};
	}

	private buildHealthRecord(providerId: string): DiscoveryHealthRecord {
		const breaker = this.healthTracker.breaker(providerId).health();
		const observation = this.providerObservations.get(providerId);
		const provider = this.providerMap.get(providerId);
		const timeoutRate = observation && observation.attemptCount > 0
			? observation.timeoutCount / observation.attemptCount
			: 0;
		const latencyClass = this.computeLatencyClass(observation);
		let state: DiscoveryHealthRecord["state"] = "unknown";

		if (observation?.lastErrorType === "auth_error") {
			state = "auth_error";
		} else if (observation?.lastErrorType === "throttled") {
			state = "throttled";
		} else if (breaker.state === "open" && observation?.attemptCount) {
			state = "down";
		} else if (provider?.lastRefreshed && (breaker.failureCount > 0 || timeoutRate >= 0.25 || latencyClass === "high")) {
			state = "degraded";
		} else if (breaker.lastSuccessTime > 0 || provider?.lastRefreshed) {
			state = "healthy";
		}

		return {
			providerId,
			state,
			failureCount: breaker.failureCount,
			lastError: breaker.lastError ?? null,
			lastSuccessAt: breaker.lastSuccessTime || provider?.lastRefreshed || null,
			lastFailureAt: breaker.lastFailureTime || null,
			latencyClass,
			timeoutRate: Number(timeoutRate.toFixed(3)),
			rateLimitState: observation?.lastErrorType === "throttled" ? "throttled" : observation?.attemptCount ? "ok" : "unknown",
			circuitState: breaker.state,
		};
	}

	private computeLatencyClass(observation: ProviderObservation | undefined): DiscoveryHealthRecord["latencyClass"] {
		if (!observation || observation.attemptCount === 0 || observation.latenciesMs.length === 0) {
			return "unknown";
		}
		if (observation.lastErrorType === "timeout") {
			return "timeout";
		}

		const average = observation.latenciesMs.reduce((sum, value) => sum + value, 0) / observation.latenciesMs.length;
		if (average <= 1_000) return "low";
		if (average <= 4_000) return "medium";
		return "high";
	}

	private discoveryCandidateModels(query: DiscoveryBindingQuery): Array<{ model: ModelCard; descriptor: ReturnType<ModelRegistry["providerDescriptor"]> }> {
		const normalizedProvider = normalizeProviderId(query.provider);
		const normalizedOriginProvider = normalizeProviderId(query.originProvider);

		return this.models({
			provider: normalizedProvider,
			originProvider: normalizedOriginProvider,
			mode: query.mode as ModelMode | undefined,
		}).flatMap((model) => {
			const descriptor = this.providerDescriptor(model.provider, this.providerMap.get(model.provider));
			if (!this.modelMatchesDiscoveryQuery(model, descriptor, query)) return [];
			return [{ model, descriptor }];
		});
	}

	private modelMatchesDiscoveryQuery(
		model: ModelCard,
		descriptor: ReturnType<ModelRegistry["providerDescriptor"]>,
		query: DiscoveryBindingQuery,
	): boolean {
		const capabilities = trustedCapabilitiesForModel(model, descriptor);
		const capability = this.normalizeTrustedCapabilityToken(query.capability);
		if (capability && !capabilities.includes(capability)) {
			return false;
		}

		if (!query.role) {
			return true;
		}

		const roleRequirements = this.roleRequirements(query.role);
		return roleRequirements.every((requiredCapability) => capabilities.includes(requiredCapability));
	}

	private roleRequirements(role: string): TrustedCapability[] {
		const normalizedRole = role.trim().toLowerCase().replace(/[\s-]+/g, "_");
		switch (normalizedRole) {
			case "tool_use":
			case "tools":
			case "functions":
				return ["chat", "function_calling"];
			case "embeddings":
			case "embedding":
				return ["embeddings"];
			case "vision":
				return ["chat", "vision"];
			case "rerank":
				return ["rerank"];
			case "local":
			case "local_exec":
				return ["local_exec"];
			case "chat":
			default:
				return [this.normalizeTrustedCapabilityToken(normalizedRole) ?? "chat"];
		}
	}

	private normalizeTrustedCapabilityToken(value: string | undefined): TrustedCapability | undefined {
		if (!value) return undefined;
		const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
		const map: Record<string, TrustedCapability> = {
			chat: "chat",
			embedding: "embeddings",
			embeddings: "embeddings",
			function_calling: "function_calling",
			tool_use: "function_calling",
			tools: "function_calling",
			vision: "vision",
			rerank: "rerank",
			structured_output: "structured_output",
			streaming: "streaming",
			long_context: "long_context",
			local_exec: "local_exec",
			local: "local_exec",
			code: "code_generation",
			code_generation: "code_generation",
			reasoning: "reasoning",
			low_latency: "low_latency",
			cheap_inference: "cheap_inference",
		};
		return map[normalized];
	}

	private discoveryQueryRecord(query: DiscoveryBindingQuery): Record<string, string | number | boolean | null> {
		return {
			role: query.role ?? null,
			capability: query.capability ?? null,
			provider: normalizeProviderId(query.provider) ?? query.provider ?? null,
			originProvider: normalizeProviderId(query.originProvider) ?? query.originProvider ?? null,
			mode: query.mode ?? null,
			limit: query.limit ?? null,
			priceMetric: query.priceMetric ?? null,
			preferLocalProviders: query.preferLocalProviders ?? null,
			allowCrossProvider: query.allowCrossProvider ?? null,
		};
	}

	private fullSnapshotChanges(snapshot: DiscoverySnapshotV1): DiscoveryChangeV1[] {
		return [
			...snapshot.providers.map((provider): DiscoveryChangeV1 => ({
				entity: "provider",
				action: "upsert",
				key: provider.providerId,
				value: provider,
			})),
			...snapshot.models.map((model): DiscoveryChangeV1 => ({
				entity: "model",
				action: "upsert",
				key: model.key,
				value: model,
			})),
			...snapshot.health.map((health): DiscoveryChangeV1 => ({
				entity: "health",
				action: "upsert",
				key: health.providerId,
				value: health,
			})),
			...snapshot.credentialPrompts.map((prompt): DiscoveryChangeV1 => ({
				entity: "credential_prompt",
				action: "upsert",
				key: prompt.providerId,
				value: prompt,
			})),
		];
	}

	private diffSnapshots(previous: DiscoverySnapshotV1, next: DiscoverySnapshotV1): DiscoveryDeltaV1 {
		const changes: DiscoveryChangeV1[] = [];
		this.collectSectionChanges("provider", previous.providers, next.providers, (item) => item.providerId, changes);
		this.collectSectionChanges("model", previous.models, next.models, (item) => item.key, changes);
		this.collectSectionChanges("health", previous.health, next.health, (item) => item.providerId, changes);
		this.collectSectionChanges("credential_prompt", previous.credentialPrompts, next.credentialPrompts, (item) => item.providerId, changes);

		return {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			sinceCursor: previous.cursor,
			cursor: next.cursor,
			changedAt: next.discoveredAt,
			resetRequired: false,
			changes,
		};
	}

	private collectSectionChanges<T>(
		entity: DiscoveryChangeV1["entity"],
		previous: T[],
		next: T[],
		keyOf: (item: T) => string,
		target: DiscoveryChangeV1[],
	): void {
		const previousMap = new Map(previous.map((item) => [keyOf(item), item]));
		const nextMap = new Map(next.map((item) => [keyOf(item), item]));

		for (const [key, item] of nextMap) {
			const prev = previousMap.get(key);
			if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) {
				target.push({ entity, action: "upsert", key, value: item as DiscoveryChangeV1["value"] });
			}
		}

		for (const key of previousMap.keys()) {
			if (!nextMap.has(key)) {
				target.push({ entity, action: "remove", key, value: null });
			}
		}
	}

	private recordObservation(providerId: string, entry: { latencyMs: number; errorType: ProviderObservation["lastErrorType"] }): void {
		const observation = this.providerObservations.get(providerId) ?? {
			latenciesMs: [],
			timeoutCount: 0,
			attemptCount: 0,
			lastErrorType: null,
		};

		observation.attemptCount += 1;
		observation.latenciesMs.push(entry.latencyMs);
		if (observation.latenciesMs.length > 20) {
			observation.latenciesMs.shift();
		}
		if (entry.errorType === "timeout") {
			observation.timeoutCount += 1;
		}
		observation.lastErrorType = entry.errorType;
		this.providerObservations.set(providerId, observation);
	}

	private classifyError(errorMessage: string): ProviderObservation["lastErrorType"] {
		const lower = errorMessage.toLowerCase();
		if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
			return "auth_error";
		}
		if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
			return "throttled";
		}
		if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("abort")) {
			return "timeout";
		}
		if (lower.includes("network") || lower.includes("econn") || lower.includes("fetch failed") || lower.includes("5")) {
			return "transport";
		}
		return "unknown";
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
		registry.currentCursor = registry.makeCursor();
		registry.lastSnapshotCache = registry.buildSnapshot(registry.currentCursor);
		return registry;
	}

	// ---------------------------------------------------------------------------
	// Config file loading
	// ---------------------------------------------------------------------------

	/**
	 * Load configuration from disk and merge with explicit overrides.
	 *
	 * Reads up to two JSON config files (in increasing priority):
	 * 1. Global: `~/.kosharc.json`
	 * 2. Project: `kosha.config.json` in the current working directory
	 *
	 * Explicit `overrides` take highest priority. Missing files are silently skipped.
	 *
	 * @param overrides - Programmatic config that takes precedence over file values.
	 * @returns Merged configuration ready for the ModelRegistry constructor.
	 */
	static async loadConfigFile(overrides?: KoshaConfig): Promise<KoshaConfig> {
		const layers: KoshaConfig[] = [];

		// Layer 1: global config
		const globalPath = join(homedir(), ".kosharc.json");
		const globalConfig = await ModelRegistry.readJsonFile<KoshaConfig>(globalPath);
		if (globalConfig) layers.push(globalConfig);

		// Layer 2: project-level config
		const projectPath = join(process.cwd(), "kosha.config.json");
		const projectConfig = await ModelRegistry.readJsonFile<KoshaConfig>(projectPath);
		if (projectConfig) layers.push(projectConfig);

		// Layer 3: explicit overrides
		if (overrides) layers.push(overrides);

		if (layers.length === 0) return {};

		// Shallow merge — later layers override earlier ones.
		// providers and aliases get deep-merged one level.
		return layers.reduce<KoshaConfig>((merged, layer) => {
			return {
				...merged,
				...layer,
				providers: { ...merged.providers, ...layer.providers },
				aliases: { ...merged.aliases, ...layer.aliases },
			};
		}, {});
	}

	private static async readJsonFile<T>(filePath: string): Promise<T | null> {
		try {
			const raw = await readFile(filePath, "utf-8");
			return JSON.parse(raw) as T;
		} catch (err: unknown) {
			if (err instanceof SyntaxError) {
				console.warn(`kosha: config file has invalid JSON: ${filePath}`);
			}
			return null;
		}
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
			const all: ProviderDiscoverer[] = discoveryModule.getAllDiscoverers({
				ollamaBaseUrl: getProviderConfig(this.config, "ollama")?.baseUrl,
				llamaCppBaseUrl: getProviderConfig(this.config, "llama.cpp")?.baseUrl,
			});

			let filtered = all;

			// Filter to requested providers
			if (providerIds && providerIds.length > 0) {
				const normalizedProviderIds = providerIds.map((providerId) => normalizeProviderId(providerId) ?? providerId);
				filtered = filtered.filter((d) => normalizedProviderIds.includes(d.providerId));
			}

			// Exclude local providers unless explicitly included
			if (includeLocal === false) {
				filtered = filtered.filter((d) => !isLocalProvider(d.providerId));
			}

			// Filter out providers that are disabled in config
			if (this.config.providers) {
				filtered = filtered.filter((d) => {
					const provConfig = getProviderConfig(this.config, d.providerId);
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
		const normalizedProviderId = normalizeProviderId(providerId) ?? providerId;
		if (explicitKey) {
			return { apiKey: explicitKey, source: "config" };
		}

		const envMap: Record<string, string> = {
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
		};

		const envVar = envMap[normalizedProviderId];
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
