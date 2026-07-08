/**
 * kosha-discovery (कोश) — AI Model & Provider Discovery Registry
 *
 * Core type definitions for the model registry system.
 * All interfaces here are provider-agnostic; concrete discoverers
 * map provider-specific API responses into these shapes.
 * @module
 */

/** Supported model operational modes. */
export type ModelMode = "chat" | "embedding" | "image" | "video" | "audio" | "moderation" | "rerank";

/** Normalized transport families used by discovery consumers. */
export type ProviderTransport = "native-http" | "openai-compatible-http" | "cloud-sdk";

/** High-level provider origin classifications. */
export type ProviderOrigin = "direct" | "proxy" | "local";

/** Broad execution target for local runtimes. */
export type ComputeTarget = "cpu" | "gpu" | "hybrid" | "unknown";

/** Price scoring metric for cheapest-model selection. */
export type PricingMetric = "input" | "output" | "blended";

/**
 * How a provider handles prompt-cache TTL.
 *
 * - `explicit`: the caller chooses TTL per request (Anthropic cache_control,
 *   Gemini cachedContent). `ttlTiers` lists discrete options when they exist;
 *   `defaultTtlSeconds` / `maxTtlSeconds` describe continuous configuration.
 * - `automatic`: provider manages cache lifetime; `approximateTtlSeconds`
 *   captures the observed/published rough TTL.
 * - `passthrough`: a gateway/aggregator that forwards `cache_control` to the
 *   underlying provider — actual TTL inherits from the routed model.
 * - `none`: no documented prompt cache.
 */
export type ProviderCacheMode = "explicit" | "automatic" | "passthrough" | "none";

/** Provider-level prompt-cache behavior. */
export interface ProviderCacheBehavior {
	mode: ProviderCacheMode;
	/** Discrete TTL options the caller can pick (e.g. ["5m", "1h"] on Anthropic). */
	ttlTiers?: readonly string[];
	/** Default TTL applied when the caller does not specify one. */
	defaultTtlSeconds?: number;
	/** Maximum TTL allowed by the provider (explicit-mode only). */
	maxTtlSeconds?: number;
	/** Approximate eviction window when `mode === "automatic"`. */
	approximateTtlSeconds?: number;
	/** True when TTL is provider-documented; false when only empirically observed. */
	documented: boolean;
	/** Short prose for nuances that don't fit the structured fields. */
	notes?: string;
}

/** Token pricing in USD per million tokens. */
export interface ModelPricing {
	/** USD cost per 1 million input tokens. */
	inputPerMillion: number;
	/** USD cost per 1 million output tokens. */
	outputPerMillion: number;
	/** USD cost per 1 million reasoning-input tokens (optional). */
	reasoningInputPerMillion?: number;
	/** USD cost per 1 million reasoning-output tokens (optional). */
	reasoningOutputPerMillion?: number;
	/** USD cost per 1 million cache-read tokens (optional). */
	cacheReadPerMillion?: number;
	/** USD cost per 1 million cache-write tokens (optional). */
	cacheWritePerMillion?: number;
	/** USD cost per 1 million input tokens via the Batch API (optional). */
	batchInputPerMillion?: number;
	/** USD cost per 1 million output tokens via the Batch API (optional). */
	batchOutputPerMillion?: number;
	/**
	 * USD cost per input image for vision-capable models that bill per image
	 * (OpenAI GPT-4o, Anthropic Claude vision) rather than per pixel-token.
	 */
	imageInputPerImage?: number;
	/**
	 * USD cost per output image for image-generation models (DALL-E, Imagen,
	 * Stable Diffusion-style endpoints) that bill per rendered image.
	 */
	imageOutputPerImage?: number;
	/**
	 * USD cost per 1 million audio-input tokens for models that tokenize audio
	 * (GPT-4o Realtime, Gemini 2.x native audio).
	 */
	audioInputPerMillion?: number;
	/**
	 * USD cost per 1 million audio-output tokens for speech-generation models
	 * that emit audio as tokens.
	 */
	audioOutputPerMillion?: number;
	/**
	 * USD cost per second of audio input for providers that bill by duration
	 * instead of token count (Whisper, AssemblyAI, Gemini audio-per-second).
	 */
	audioInputPerSecond?: number;
	/**
	 * USD cost per second of audio output for TTS providers that bill by
	 * synthesised duration (ElevenLabs, Cartesia, OpenAI TTS per-second tier).
	 */
	audioOutputPerSecond?: number;
	/**
	 * USD cost per second of video input for multimodal models that bill
	 * by video duration (Gemini 2.x video).
	 */
	videoInputPerSecond?: number;
	/**
	 * USD cost per second of generated video output for text/image-to-video
	 * providers that bill by rendered duration.
	 */
	videoOutputPerSecond?: number;
	/**
	 * USD cost per 1 million video-input tokens for models that tokenize
	 * video frames (newer Gemini long-video variants).
	 */
	videoInputPerMillion?: number;
	/** USD cost per 1,000 web-search/tool-grounding requests. */
	webSearchPerThousandRequests?: number;
	/** USD cost per 1,000 maps/search-grounding requests. */
	mapsSearchPerThousandRequests?: number;
	/** USD cost per 1,000 generic requests when a provider bills per query. */
	requestPerThousand?: number;
	/**
	 * USD cost per 1 million characters for providers that bill by character
	 * rather than token (Vertex AI text models, some Azure endpoints).
	 */
	inputPerMillionCharacters?: number;
	/**
	 * USD cost per 1 million output characters for character-billed providers.
	 */
	outputPerMillionCharacters?: number;
	/**
	 * USD cost per 1 million input tokens when the prompt exceeds the
	 * long-context tier threshold (e.g. Gemini > 128k tokens tier).
	 */
	longContextInputPerMillion?: number;
	/**
	 * USD cost per 1 million output tokens when operating in the long-context
	 * pricing tier.
	 */
	longContextOutputPerMillion?: number;
	/**
	 * Token-count threshold above which long-context pricing applies
	 * (e.g. 128_000 for Gemini 1.5/2.5 tiered pricing).
	 */
	longContextThresholdTokens?: number;
}

/**
 * Tool / function-calling dialect families.
 *
 * A dialect captures the JSON shape of the tool definition, the field names
 * the API expects (`tools` vs. `functions`, `tool_choice` vs. `function_call`),
 * and the runtime event stream used to deliver tool calls. Consumers build
 * adapters per dialect; the model card surfaces which dialect to target.
 */
export type ToolDialect =
	/** Classic OpenAI function/tool calling (`tools` array, `tool_choice`). */
	| "openai-tools"
	/** OpenAI Responses API tools (`input` events, `response.output_item.*`). */
	| "openai-responses"
	/** Anthropic Messages API `tool_use` / `tool_result` content blocks. */
	| "anthropic-tools"
	/** Google Gemini `function_declarations` + `functionCall` parts. */
	| "gemini-functions"
	/** Cohere `tools` parameter with `tool_calls` in the response body. */
	| "cohere-tools"
	/** Mistral `tools` array — OpenAI-compatible but with Mistral quirks. */
	| "mistral-tools"
	/** Meta Llama 3.x JSON tool-call format (`<|python_tag|>` style). */
	| "llama3-tools"
	/** Model does not expose first-class tool calling. */
	| "none";

/**
 * Structured-output production modes a model can enforce.
 *
 * The enum describes how the caller can constrain the model's output shape.
 * Multiple modes can apply to a single model (e.g. OpenAI GPT-4o supports
 * both `json-mode` and `json-schema`). The registry surfaces the set so
 * downstream consumers can pick the most precise mode they can use.
 */
export type StructuredOutputMode =
	/** OpenAI `response_format: { type: "json_object" }`. */
	| "json-mode"
	/** OpenAI `response_format: { type: "json_schema" }` with strict validation. */
	| "json-schema"
	/** Gemini `response_schema` + `response_mime_type: "application/json"`. */
	| "response-schema"
	/** Generic `response_format` envelope (OpenRouter, Together, Fireworks). */
	| "response-format"
	/** llama.cpp / exllama grammar-constrained decoding (GBNF or JSON schema). */
	| "grammar"
	/** Anthropic tool-use coerced as structured-output trick. */
	| "tool-choice"
	/** Anthropic-style XML-tag guidance (prompt-level, not enforced). */
	| "xml";

/**
 * Model lifecycle status used for routing and deprecation warnings.
 *
 * - `active` — fully supported, safe to bind long-term.
 * - `preview` — usable but API/pricing may change without notice.
 * - `deprecated` — still served, but replaced; plan migration.
 * - `retired` — no longer served; kept in catalog for backfill / historical.
 */
export type ModelStatus = "active" | "preview" | "deprecated" | "retired";

/**
 * Provenance of a model's pricing block, used to signal how trustworthy or
 * fresh the rates are.
 *
 * - `provider-live` — priced by the serving provider's live API response.
 * - `litellm` — filled by the LiteLLM community-catalogue enrichment pass.
 * - `static-seed` — came from a keyless static seed (models.dev / litellm
 *   seed) or a hand-curated (`manual`) entry.
 * - `missing` — a routable model that ended up with no usable pricing.
 */
export type PricingSource = "provider-live" | "litellm" | "static-seed" | "missing";

/**
 * Local-runtime metadata surfaced for first-class local providers.
 *
 * Values are optional because local runtimes vary widely in what they expose.
 * The versioned discovery schema will serialize unknown values as `null`.
 */
export interface LocalRuntimeMetadata {
	/** Canonical runtime family, e.g. `"ollama"` or `"llama.cpp"`. */
	runtimeFamily: string;
	/** Normalized transport family used by this runtime. */
	transport: ProviderTransport;
	/** Best-effort tokenizer family, when exposed by the runtime. */
	tokenizerFamily?: string;
	/** Quantization level / format, e.g. `"Q4_K_M"` or `"F16"`. */
	quantization?: string;
	/** Best-effort memory footprint estimate in bytes. */
	memoryFootprintBytes?: number;
	/** Best-effort target device class. */
	computeTarget?: ComputeTarget;
	/** Whether the runtime is known to support structured outputs / grammars. */
	supportsStructuredOutput?: boolean;
	/** Whether the runtime is known to support token streaming. */
	supportsStreaming?: boolean;
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
	/** Original free-form capability tags retained for compatibility/debugging. */
	rawCapabilities?: string[];
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum number of output tokens the model can generate. */
	maxOutputTokens: number;
	/** Token pricing information (filled by enrichment or API). */
	pricing?: ModelPricing;
	/** Reference direct-provider pricing for proxied routes (optional). */
	originPricing?: ModelPricing;
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
	/** Local-runtime metadata for Ollama / llama.cpp style providers. */
	localRuntime?: LocalRuntimeMetadata;
	/**
	 * Best-effort tokenizer family identifier.
	 *
	 * Normalized string such as `"o200k_base"`, `"cl100k_base"`, `"claude"`,
	 * `"gemini"`, `"llama3"`, `"mistral"`, `"cohere"`, `"deepseek"`. For local
	 * runtimes this is copied from {@link LocalRuntimeMetadata.tokenizerFamily}
	 * when present; for API-served models it is derived via
	 * {@link inferTokenizerFamily}. Consumers use it for tokenizer-aware
	 * compression and routing decisions.
	 */
	tokenizerFamily?: string;
	/**
	 * Tool-calling dialect the model speaks natively.
	 *
	 * Consumers use this to pick the correct adapter when binding a tool
	 * registry to a model (OpenAI `tools` vs. Anthropic `tool_use` blocks
	 * vs. Gemini `function_declarations` vs. Cohere/Mistral/Llama shapes).
	 * Inferred via {@link inferToolDialect} when not provided by the API.
	 */
	toolDialect?: ToolDialect;
	/**
	 * Structured-output production modes the model supports.
	 *
	 * A model can advertise multiple modes (e.g. OpenAI GPT-4o supports both
	 * `json-mode` and `json-schema`). Consumers should pick the most
	 * precise mode available to them. Inferred via
	 * {@link inferStructuredOutputModes} when not provided by the API.
	 */
	structuredOutputModes?: StructuredOutputMode[];
	/**
	 * Whether the model supports multiple tool calls in a single turn.
	 *
	 * Relevant for agent loops and parallel tool-use optimizations.
	 * OpenAI GPT-4o and newer, Anthropic Claude 3.5+, and most modern
	 * frontier models return true; legacy models return false.
	 */
	supportsParallelToolCalls?: boolean;
	/**
	 * Lifecycle status of the model.
	 *
	 * Used by routing policies to warn callers binding to deprecated models
	 * and to filter retired entries out of active selection queries.
	 * Defaults to `"active"` when unspecified.
	 */
	status?: ModelStatus;
	/**
	 * Provenance of the {@link pricing} block, when attributable.
	 *
	 * Set during the enrich/merge pass: `"provider-live"` when the serving
	 * API returned rates, `"static-seed"` for keyless seed/manual entries,
	 * `"litellm"` when the community-catalogue enrichment filled it, and
	 * `"missing"` for a routable model that ended up unpriced. Consumers use
	 * this to decide how much to trust a quoted rate.
	 */
	pricingSource?: PricingSource;
	/**
	 * ISO-8601 deprecation date (e.g. `"2026-06-03"`).
	 *
	 * When set, the provider has announced an end-of-service date after
	 * which the model will be retired. Consumers can surface warnings
	 * or auto-migrate bindings ahead of the date.
	 */
	deprecationDate?: string;
	/**
	 * Canonical model ID suggested by the provider as a replacement.
	 *
	 * Only set for deprecated models when the provider publishes a
	 * successor (e.g. `gpt-4` → `gpt-4o`). Consumers use it to build
	 * automatic-migration suggestions.
	 */
	replacedBy?: string;
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
	/** Whether this provider requires credentials to discover or execute models. */
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

/** Error captured when a provider's discovery fails during {@link ModelRegistry.discover}. */
export interface DiscoveryError {
	/** Provider slug that failed discovery. */
	providerId: string;
	/** Human-readable provider name. */
	providerName: string;
	/** Error message from the failed discovery attempt. */
	error: string;
	/** Unix timestamp (ms) when the error occurred. */
	timestamp: number;
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

/** Options for explicit cache-bypassing latest discovery fetches. */
export interface LatestDiscoveryOptions extends Omit<DiscoveryOptions, "force"> {}

/** Result payload returned by explicit latest discovery fetches. */
export interface LatestDiscoveryResult {
	/** Providers discovered during this latest fetch. */
	providers: ProviderInfo[];
	/** Total number of models across returned providers. */
	modelCount: number;
	/** Unix timestamp (ms) when discovery completed. */
	discoveredAt: number;
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
