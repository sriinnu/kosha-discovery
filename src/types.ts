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
