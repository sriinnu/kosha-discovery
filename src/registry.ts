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
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { AliasResolver } from "./aliases.js";
import { KoshaCache } from "./cache.js";
import { extractModelVersion, extractOriginProvider, normalizeModelId } from "./normalize.js";

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

const PROVIDER_CREDENTIAL_REQUIREMENTS: Record<string, { required: boolean; envVars: string[] }> = {
	anthropic: { required: true, envVars: ["ANTHROPIC_API_KEY"] },
	openai: { required: true, envVars: ["OPENAI_API_KEY"] },
	google: { required: true, envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"] },
	openrouter: { required: false, envVars: ["OPENROUTER_API_KEY"] },
	ollama: { required: false, envVars: [] },
	bedrock: { required: true, envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
	vertex: { required: true, envVars: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"] },
};

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

		// Collect successful results and record failures
		this.lastDiscoveryErrors = [];
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (result.status === "fulfilled") {
				this.providerMap.set(result.value.id, result.value);
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

		for (const providerInfo of this.providerMap.values()) {
			if (filter?.provider && providerInfo.id !== filter.provider) {
				continue;
			}

			for (const model of providerInfo.models) {
				// Provider-aware dedup key prevents collapsing cross-provider routes.
				const dedupKey = `${model.provider}:${model.id}`;
				if (seen.has(dedupKey)) continue;

				if (filter?.originProvider && model.originProvider !== filter.originProvider) continue;
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
		const providers: ProviderRoleInfo[] = [];

		for (const providerInfo of this.providerMap.values()) {
			if (filter?.provider && providerInfo.id !== filter.provider) {
				continue;
			}

			const models = providerInfo.models.filter((model) => {
				if (filter?.originProvider && model.originProvider !== filter.originProvider) return false;
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

		for (const provider of this.providerMap.values()) {
			if (providerIds && providerIds.length > 0 && !providerIds.includes(provider.id)) {
				continue;
			}

			const requirement = PROVIDER_CREDENTIAL_REQUIREMENTS[provider.id];
			if (!requirement || !requirement.required) {
				continue;
			}

			if (provider.authenticated) {
				continue;
			}

			const envHint = requirement.envVars.length > 0
				? `Set ${requirement.envVars.join(" or ")}`
				: "Configure credentials";

			prompts.push({
				providerId: provider.id,
				providerName: provider.name,
				required: true,
				envVars: requirement.envVars,
				message: `${envHint} to enable ${provider.name} model discovery.`,
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
		return this.providerMap.get(id);
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
		} catch {
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
