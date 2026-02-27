/**
 * kosha-discovery (कोश) — AI Model & Provider Discovery Registry
 *
 * Core type definitions for the model registry system.
 * All interfaces here are provider-agnostic; concrete discoverers
 * map provider-specific API responses into these shapes.
 * @module
 */

/** Supported model operational modes. */
export type ModelMode = "chat" | "embedding" | "image" | "audio" | "moderation";

/** Price scoring metric for cheapest-model selection. */
export type PricingMetric = "input" | "output" | "blended";

/** Token pricing in USD per million tokens. */
export interface ModelPricing {
	/** USD cost per 1 million input tokens. */
	inputPerMillion: number;
	/** USD cost per 1 million output tokens. */
	outputPerMillion: number;
	/** USD cost per 1 million cache-read tokens (optional). */
	cacheReadPerMillion?: number;
	/** USD cost per 1 million cache-write tokens (optional). */
	cacheWritePerMillion?: number;
}

/**
 * A normalized descriptor for a single AI model.
 *
 * Every discoverer produces `ModelCard` instances so that consumers
 * get a uniform shape regardless of the upstream provider API.
 * The `provider` field reflects the serving layer (e.g. "openrouter",
 * "bedrock", "vertex"), while `originProvider` holds the original
 * model creator (e.g. "anthropic", "openai", "google").
 */
export interface ModelCard {
	/** Provider's canonical model ID (e.g. "claude-opus-4-6"). */
	id: string;
	/** Human-readable display name (e.g. "Claude Opus 4"). */
	name: string;
	/**
	 * Serving-layer provider identifier.
	 * Examples: "anthropic", "openai", "openrouter", "bedrock", "vertex".
	 */
	provider: string;
	/**
	 * Original model creator, distinct from the serving layer when a model
	 * is accessed through a proxy or managed service.
	 * Examples: "anthropic" when served via "openrouter" or "bedrock";
	 *           "google" when served via "vertex".
	 */
	originProvider?: string;
	/** Primary operational mode of the model. */
	mode: ModelMode;
	/** Feature flags: "chat", "vision", "function_calling", "nlu", "code", "embedding", etc. */
	capabilities: string[];
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum number of output tokens the model can generate. */
	maxOutputTokens: number;
	/** Token pricing information (filled by enrichment or API). */
	pricing?: ModelPricing;
	/** Output vector dimensionality (only for embedding models). */
	dimensions?: number;
	/** Maximum input chunk size in tokens (only for embedding models). */
	maxInputTokens?: number;
	/** Short alias names that resolve to this model (e.g. ["opus", "opus-4"]). */
	aliases: string[];
	/** Unix timestamp (ms) when this model was discovered. */
	discoveredAt: number;
	/** How this model entry was obtained. */
	source: "api" | "litellm" | "local" | "manual";
	/** AWS region for Bedrock-served models (e.g. "us-east-1"). */
	region?: string;
	/** GCP project ID for Vertex AI-served models (e.g. "my-gcp-project"). */
	projectId?: string;
}

/**
 * A model projection used for role/capability matrix views.
 *
 * `roles` is a union of the model's primary mode plus all declared capability
 * flags, deduplicated and normalized for routing use-cases.
 */
export interface ModelRoleCard {
	/** Provider's canonical model ID. */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** Serving-layer provider slug. */
	provider: string;
	/** Original model creator (if different from serving provider). */
	originProvider?: string;
	/** Primary model mode. */
	mode: ModelMode;
	/** Deduplicated role/capability list (e.g. ["chat", "vision", "function_calling"]). */
	roles: string[];
	/** Optional pricing copied from the base model card. */
	pricing?: ModelPricing;
}

/** Provider-level role matrix view used by assistants and routing clients. */
export interface ProviderRoleInfo {
	/** Unique provider slug. */
	id: string;
	/** Human-readable provider name. */
	name: string;
	/** Whether an auth credential was resolved for this provider. */
	authenticated: boolean;
	/** How credential was sourced, if available. */
	credentialSource?: "env" | "cli" | "config" | "oauth" | "none";
	/** Role-augmented model projections for this provider. */
	models: ModelRoleCard[];
}

/** Query options for role-based model/provider views. */
export interface RoleQueryOptions {
	/** Restrict to one serving-layer provider. */
	provider?: string;
	/** Restrict by model creator/provider. */
	originProvider?: string;
	/** Restrict by primary mode. */
	mode?: ModelMode;
	/** Restrict by normalized capability tag (e.g. "vision", "embedding"). */
	capability?: string;
	/** Flexible role query alias (e.g. "embeddings", "image", "tool_use"). */
	role?: string;
}

/** Prompt metadata for providers missing required credentials. */
export interface ProviderCredentialPrompt {
	/** Provider slug. */
	providerId: string;
	/** Provider display name. */
	providerName: string;
	/** Whether this provider requires credentials to discover/use models. */
	required: boolean;
	/** Environment variable names that satisfy the credential requirement. */
	envVars: string[];
	/** Human-readable prompt text suitable for assistant UX. */
	message: string;
}

/** Query options for cheapest-model selection. */
export interface CheapestModelOptions extends RoleQueryOptions {
	/** Maximum number of ranked matches to return (default: 5). */
	limit?: number;
	/** Pricing comparator metric (default inferred from role/mode). */
	priceMetric?: PricingMetric;
	/** Weight applied to input-token price when using `blended` metric (default: 1). */
	inputWeight?: number;
	/** Weight applied to output-token price when using `blended` metric (default: 1). */
	outputWeight?: number;
	/** Include unpriced models at the end of results with undefined score. */
	includeUnpriced?: boolean;
}

/** A ranked cheapest-model match with its computed score. */
export interface CheapestModelMatch {
	/** Ranked model candidate. */
	model: ModelCard;
	/** Computed cost score (undefined when model has no usable pricing). */
	score?: number;
	/** Metric used for scoring this result set. */
	priceMetric: PricingMetric;
}

/** Full cheapest-model query response with diagnostics for callers. */
export interface CheapestModelResult {
	/** Ranked matches sorted by ascending score. */
	matches: CheapestModelMatch[];
	/** Total models matching non-price filters before pricing checks. */
	candidates: number;
	/** Models with usable pricing for the selected metric. */
	pricedCandidates: number;
	/** Matching models excluded due to missing/invalid pricing. */
	skippedNoPricing: number;
	/** Metric actually used to compute scores. */
	priceMetric: PricingMetric;
	/** Providers that are likely missing required API keys. */
	missingCredentials: ProviderCredentialPrompt[];
}

/** Aggregated capability summary returned by {@link ModelRegistry.capabilities}. */
export interface CapabilitySummary {
	/** Normalized capability/role string (e.g. "vision", "embedding", "function_calling"). */
	capability: string;
	/** Number of distinct models that declare this capability. */
	modelCount: number;
	/** Number of unique serving-layer providers that offer this capability. */
	providerCount: number;
	/** List of unique provider slugs that serve models with this capability. */
	providers: string[];
	/** Unique model modes seen among models with this capability. */
	modes: ModelMode[];
	/** An example model ID for quick reference (first encountered). */
	exampleModelId?: string;
}

/** Detailed provider route info for a model across serving layers. */
export interface ModelRouteInfo {
	/** Original model card for this route. */
	model: ModelCard;
	/** Serving provider ID (same as `model.provider`). */
	provider: string;
	/** Resolved model creator/provider (origin). */
	originProvider: string;
	/** Base URL of the serving provider API, when known. */
	baseUrl?: string;
	/** Parsed model version hint (date, semantic version, or provider suffix). */
	version?: string;
	/** True when the model is served directly by its origin provider. */
	isDirect: boolean;
	/** True when this route is recommended for invocation. */
	isPreferred: boolean;
}

/**
 * Aggregated info about a single AI provider and the models it serves.
 */
export interface ProviderInfo {
	/** Unique provider slug (e.g. "anthropic"). */
	id: string;
	/** Human-readable provider name (e.g. "Anthropic"). */
	name: string;
	/** Base URL for the provider's API. */
	baseUrl: string;
	/** Whether a valid credential was found for this provider. */
	authenticated: boolean;
	/** How the credential was obtained, if any. */
	credentialSource?: "env" | "cli" | "config" | "oauth" | "none";
	/** All models discovered from this provider. */
	models: ModelCard[];
	/** Unix timestamp (ms) of the last successful refresh. */
	lastRefreshed: number;
}

/**
 * Options passed to {@link ModelRegistry.discover} to control
 * which providers are queried and how.
 */
export interface DiscoveryOptions {
	/** Limit discovery to these provider IDs (default: all). */
	providers?: string[];
	/** Whether to scan local runtimes like Ollama / LM Studio (default: true). */
	includeLocal?: boolean;
	/** Per-provider HTTP timeout in milliseconds (default: 10 000). */
	timeout?: number;
	/** Enrich models with litellm pricing/context data (default: true). */
	enrichWithPricing?: boolean;
	/** Bypass the disk cache and force fresh API calls. */
	force?: boolean;
}

/**
 * Top-level configuration for the kosha registry.
 */
export interface KoshaConfig {
	/** Directory path for the disk cache (default: ~/.kosha). */
	cacheDir?: string;
	/** Cache time-to-live in milliseconds (default: 86 400 000 = 24 h). */
	cacheTtlMs?: number;
	/** Per-provider overrides: enable/disable, explicit API keys, custom base URLs. */
	providers?: Record<
		string,
		{
			/** Set to false to skip this provider during discovery. */
			enabled?: boolean;
			/** Explicit API key — takes precedence over env / CLI sources. */
			apiKey?: string;
			/** Override the default API base URL for this provider. */
			baseUrl?: string;
		}
	>;
	/** Custom user-defined alias mappings (merged on top of built-in defaults). */
	aliases?: Record<string, string>;
}

/**
 * The result of a credential lookup for a single provider.
 */
export interface CredentialResult {
	/** Raw API key string, if found. */
	apiKey?: string;
	/** OAuth / bearer access token, if found. */
	accessToken?: string;
	/** How the credential was discovered. */
	source: "env" | "cli" | "config" | "oauth" | "none";
	/** Filesystem path the credential was read from, if applicable. */
	path?: string;
	/**
	 * Provider-specific metadata bag.
	 * For AWS Bedrock: `{ region: "us-east-1" }`.
	 * For GCP Vertex: `{ projectId: "my-project", region: "us-central1" }`.
	 */
	metadata?: Record<string, string>;
}

/**
 * Contract that every provider-specific discoverer must implement.
 */
export interface ProviderDiscoverer {
	/** Unique provider slug (e.g. "anthropic"). */
	readonly providerId: string;
	/** Human-readable provider name. */
	readonly providerName: string;
	/** Default API base URL. */
	readonly baseUrl: string;
	/**
	 * Query the provider API and return normalized {@link ModelCard} instances.
	 * @param credential - Resolved credential for authentication.
	 * @param options    - Optional timeout configuration.
	 */
	discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]>;
}

/**
 * Contract for post-discovery enrichment passes (e.g. litellm pricing).
 */
export interface Enricher {
	/**
	 * Augment model cards with additional data (pricing, context windows, etc.).
	 * Must return new objects — never mutate the originals.
	 */
	enrich(models: ModelCard[]): Promise<ModelCard[]>;
}
