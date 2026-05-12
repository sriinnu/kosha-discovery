/**
 * kosha-discovery — Canonical provider catalog.
 *
 * I keep provider identity, aliases, transport, credential requirements,
 * and default base URLs in one place so discovery, credentials, and the
 * versioned schema do not drift apart.
 * @module
 */

import type { KoshaConfig, ProviderCacheBehavior, ProviderOrigin, ProviderTransport } from "./types.js";

/**
 * Stable provider descriptor used by normalization and v1 schema emission.
 */
export interface ProviderDescriptor {
	/** Canonical provider ID exposed to discovery consumers. */
	providerId: string;
	/** Stable canonical ID; repeated for clarity in external schemas. */
	canonicalProviderId: string;
	/** Provider aliases accepted in config and queries. */
	aliases: string[];
	/** Human-friendly display name. */
	name: string;
	/** High-level origin classification. */
	origin: ProviderOrigin;
	/** True when the runtime is local to the machine. */
	isLocal: boolean;
	/** Transport family exposed by the provider. */
	transport: ProviderTransport;
	/** Default base URL used by the built-in discoverer. */
	defaultBaseUrl: string;
	/** Whether model discovery normally requires credentials. */
	credentialRequired: boolean;
	/** Whether execution/model requests require credentials; defaults to `credentialRequired`. */
	executionCredentialRequired?: boolean;
	/** Environment variables that satisfy the provider credential requirement. */
	credentialEnvVars: string[];
	/** The single env var that `fallbackRegistryCredential` reads for this provider. */
	primaryCredentialEnvVar?: string;
	/**
	 * Minimum prompt-prefix size (in tokens) required for the provider's prompt
	 * cache to engage. Only set when the provider publishes a documented floor.
	 * Undefined means either "no cache support" or "no documented floor"; the
	 * consumer should fall back to its own conservative default in that case.
	 */
	minCachePrefixTokens?: number;
	/**
	 * Prompt-cache TTL semantics for the provider. Undefined means the policy
	 * has not been curated yet — distinct from `{ mode: "none" }` which asserts
	 * the provider documents no prompt cache.
	 */
	cacheBehavior?: ProviderCacheBehavior;
}

/**
 * Canonical provider catalog.
 *
 * I keep this intentionally compact. When a provider alias is accepted,
 * it must resolve here first before discovery or config lookup proceeds.
 */
export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
	{
		providerId: "anthropic",
		canonicalProviderId: "anthropic",
		aliases: [],
		name: "Anthropic",
		origin: "direct",
		isLocal: false,
		transport: "native-http",
		defaultBaseUrl: "https://api.anthropic.com",
		credentialRequired: true,
		credentialEnvVars: ["ANTHROPIC_API_KEY"],
		primaryCredentialEnvVar: "ANTHROPIC_API_KEY",
		// Anthropic prompt cache requires ≥1024 tokens for most Claude models.
		minCachePrefixTokens: 1024,
		cacheBehavior: {
			mode: "explicit",
			ttlTiers: ["5m", "1h"],
			defaultTtlSeconds: 300,
			maxTtlSeconds: 3600,
			documented: true,
			notes: "Set per cache_control block; 1h tier requires extended-cache beta header.",
		},
	},
	{
		providerId: "openai",
		canonicalProviderId: "openai",
		aliases: [],
		name: "OpenAI",
		origin: "direct",
		isLocal: false,
		transport: "native-http",
		defaultBaseUrl: "https://api.openai.com",
		credentialRequired: true,
		credentialEnvVars: ["OPENAI_API_KEY"],
		primaryCredentialEnvVar: "OPENAI_API_KEY",
		// OpenAI prompt cache engages for prefixes ≥1024 tokens.
		minCachePrefixTokens: 1024,
		cacheBehavior: {
			mode: "automatic",
			approximateTtlSeconds: 600,
			documented: true,
			notes: "Provider-managed; typically 5–10 minutes, may extend up to an hour under load.",
		},
	},
	{
		providerId: "google",
		canonicalProviderId: "google",
		aliases: ["gemini"],
		name: "Google",
		origin: "direct",
		isLocal: false,
		transport: "native-http",
		defaultBaseUrl: "https://generativelanguage.googleapis.com",
		credentialRequired: true,
		credentialEnvVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
		primaryCredentialEnvVar: "GOOGLE_API_KEY",
		cacheBehavior: {
			mode: "explicit",
			defaultTtlSeconds: 3600,
			maxTtlSeconds: 604_800,
			documented: true,
			notes: "Gemini Context Caching: create a CachedContent with TTL up to 7 days; billed for storage + reads.",
		},
	},
	{
		providerId: "openrouter",
		canonicalProviderId: "openrouter",
		aliases: [],
		name: "OpenRouter",
		origin: "proxy",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		credentialRequired: false,
		executionCredentialRequired: true,
		credentialEnvVars: ["OPENROUTER_API_KEY"],
		primaryCredentialEnvVar: "OPENROUTER_API_KEY",
		cacheBehavior: {
			mode: "passthrough",
			documented: true,
			notes: "Forwards cache_control to the underlying provider; TTL inherits from the routed model.",
		},
	},
	{
		providerId: "vercel",
		canonicalProviderId: "vercel",
		aliases: ["ai-gateway", "ai_gateway", "vercel-ai", "vercel-ai-gateway"],
		name: "Vercel AI Gateway",
		origin: "proxy",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
		credentialRequired: false,
		executionCredentialRequired: true,
		credentialEnvVars: ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"],
		primaryCredentialEnvVar: "AI_GATEWAY_API_KEY",
		cacheBehavior: {
			mode: "passthrough",
			documented: true,
			notes: "Gateway forwards cache_control to the underlying provider; TTL inherits from the routed model.",
		},
	},
	{
		providerId: "ollama",
		canonicalProviderId: "ollama",
		aliases: [],
		name: "Ollama",
		origin: "local",
		isLocal: true,
		transport: "native-http",
		defaultBaseUrl: "http://localhost:11434",
		credentialRequired: false,
		credentialEnvVars: [],
		cacheBehavior: { mode: "none", documented: true, notes: "Local runtime — KV-cache is in-process, not a billable prompt cache." },
	},
	{
		providerId: "llama.cpp",
		canonicalProviderId: "llama.cpp",
		aliases: ["llama-cpp", "llamacpp"],
		name: "llama.cpp",
		origin: "local",
		isLocal: true,
		transport: "openai-compatible-http",
		defaultBaseUrl: "http://127.0.0.1:8080",
		credentialRequired: false,
		credentialEnvVars: [],
		cacheBehavior: { mode: "none", documented: true, notes: "Local runtime — KV-cache is in-process, not a billable prompt cache." },
	},
	{
		providerId: "bedrock",
		canonicalProviderId: "bedrock",
		aliases: ["aws-bedrock"],
		name: "AWS Bedrock",
		origin: "proxy",
		isLocal: false,
		transport: "cloud-sdk",
		defaultBaseUrl: "https://bedrock-runtime.amazonaws.com",
		credentialRequired: true,
		credentialEnvVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
		cacheBehavior: {
			mode: "passthrough",
			documented: true,
			notes: "Inherits underlying model: Anthropic-on-Bedrock supports cache_control with the same 5m/1h tiers.",
		},
	},
	{
		providerId: "vertex",
		canonicalProviderId: "vertex",
		aliases: ["vertex-ai"],
		name: "Vertex AI",
		origin: "proxy",
		isLocal: false,
		transport: "cloud-sdk",
		defaultBaseUrl: "https://aiplatform.googleapis.com",
		credentialRequired: true,
		credentialEnvVars: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"],
		cacheBehavior: {
			mode: "passthrough",
			documented: true,
			notes: "Inherits Gemini Context Caching when routing to Gemini models.",
		},
	},
	{
		providerId: "nvidia",
		canonicalProviderId: "nvidia",
		aliases: [],
		name: "NVIDIA NIM",
		origin: "proxy",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
		credentialRequired: true,
		credentialEnvVars: ["NVIDIA_API_KEY"],
		primaryCredentialEnvVar: "NVIDIA_API_KEY",
	},
	{
		providerId: "together",
		canonicalProviderId: "together",
		aliases: ["together-ai"],
		name: "Together AI",
		origin: "proxy",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.together.xyz/v1",
		credentialRequired: true,
		credentialEnvVars: ["TOGETHER_API_KEY"],
		primaryCredentialEnvVar: "TOGETHER_API_KEY",
	},
	{
		providerId: "fireworks",
		canonicalProviderId: "fireworks",
		aliases: ["fireworks-ai"],
		name: "Fireworks AI",
		origin: "proxy",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
		credentialRequired: true,
		credentialEnvVars: ["FIREWORKS_API_KEY"],
		primaryCredentialEnvVar: "FIREWORKS_API_KEY",
	},
	{
		providerId: "groq",
		canonicalProviderId: "groq",
		aliases: [],
		name: "Groq",
		origin: "proxy",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.groq.com/openai/v1",
		credentialRequired: true,
		credentialEnvVars: ["GROQ_API_KEY"],
		primaryCredentialEnvVar: "GROQ_API_KEY",
		cacheBehavior: { mode: "none", documented: true },
	},
	{
		providerId: "mistral",
		canonicalProviderId: "mistral",
		aliases: ["mistral-ai"],
		name: "Mistral",
		origin: "direct",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.mistral.ai/v1",
		credentialRequired: true,
		credentialEnvVars: ["MISTRAL_API_KEY"],
		primaryCredentialEnvVar: "MISTRAL_API_KEY",
		cacheBehavior: { mode: "none", documented: true },
	},
	{
		providerId: "deepinfra",
		canonicalProviderId: "deepinfra",
		aliases: ["deep-infra"],
		name: "DeepInfra",
		origin: "proxy",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
		credentialRequired: true,
		credentialEnvVars: ["DEEPINFRA_API_KEY"],
		primaryCredentialEnvVar: "DEEPINFRA_API_KEY",
	},
	{
		providerId: "cohere",
		canonicalProviderId: "cohere",
		aliases: [],
		name: "Cohere",
		origin: "direct",
		isLocal: false,
		transport: "native-http",
		defaultBaseUrl: "https://api.cohere.com",
		credentialRequired: true,
		credentialEnvVars: ["CO_API_KEY"],
		primaryCredentialEnvVar: "CO_API_KEY",
		cacheBehavior: { mode: "none", documented: true },
	},
	{
		providerId: "cerebras",
		canonicalProviderId: "cerebras",
		aliases: [],
		name: "Cerebras",
		origin: "direct",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.cerebras.ai/v1",
		credentialRequired: true,
		credentialEnvVars: ["CEREBRAS_API_KEY"],
		primaryCredentialEnvVar: "CEREBRAS_API_KEY",
		cacheBehavior: { mode: "none", documented: true },
	},
	{
		providerId: "perplexity",
		canonicalProviderId: "perplexity",
		aliases: [],
		name: "Perplexity",
		origin: "proxy",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.perplexity.ai",
		credentialRequired: true,
		credentialEnvVars: ["PERPLEXITY_API_KEY"],
		primaryCredentialEnvVar: "PERPLEXITY_API_KEY",
		cacheBehavior: { mode: "none", documented: true },
	},
	{
		providerId: "deepseek",
		canonicalProviderId: "deepseek",
		aliases: [],
		name: "DeepSeek",
		origin: "direct",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.deepseek.com",
		credentialRequired: true,
		credentialEnvVars: ["DEEPSEEK_API_KEY"],
		primaryCredentialEnvVar: "DEEPSEEK_API_KEY",
		cacheBehavior: {
			mode: "automatic",
			approximateTtlSeconds: 3600,
			documented: true,
			notes: "Automatic context caching; provider reports ~hours of retention but no strict guarantee.",
		},
	},
	{
		providerId: "moonshot",
		canonicalProviderId: "moonshot",
		aliases: ["kimi"],
		name: "Moonshot (Kimi)",
		origin: "direct",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.moonshot.cn",
		credentialRequired: true,
		credentialEnvVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
		primaryCredentialEnvVar: "MOONSHOT_API_KEY",
		cacheBehavior: {
			mode: "automatic",
			approximateTtlSeconds: 3600,
			documented: true,
			notes: "Kimi prompt cache is automatic on repeat prefixes; documented as long-lived but TTL not formally specified.",
		},
	},
	{
		providerId: "glm",
		canonicalProviderId: "glm",
		aliases: ["zhipu", "bigmodel"],
		name: "GLM (Zhipu)",
		origin: "direct",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
		credentialRequired: true,
		credentialEnvVars: ["GLM_API_KEY", "ZHIPUAI_API_KEY"],
		primaryCredentialEnvVar: "GLM_API_KEY",
	},
	{
		providerId: "zai",
		canonicalProviderId: "zai",
		aliases: ["z-ai", "z.ai"],
		name: "Z.AI",
		origin: "direct",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.z.ai/api/paas/v4",
		credentialRequired: true,
		credentialEnvVars: ["ZAI_API_KEY"],
		primaryCredentialEnvVar: "ZAI_API_KEY",
	},
	{
		providerId: "minimax",
		canonicalProviderId: "minimax",
		aliases: [],
		name: "MiniMax",
		origin: "direct",
		isLocal: false,
		transport: "openai-compatible-http",
		defaultBaseUrl: "https://api.minimax.io",
		credentialRequired: true,
		credentialEnvVars: ["MINIMAX_API_KEY"],
		primaryCredentialEnvVar: "MINIMAX_API_KEY",
	},
] as const;

const PROVIDER_LOOKUP = new Map<string, ProviderDescriptor>();
for (const descriptor of PROVIDER_CATALOG) {
	PROVIDER_LOOKUP.set(descriptor.providerId, descriptor);
	PROVIDER_LOOKUP.set(descriptor.canonicalProviderId, descriptor);
	for (const alias of descriptor.aliases) {
		PROVIDER_LOOKUP.set(alias, descriptor);
	}
}

/**
 * Return the canonical provider ID for a possibly-aliased identifier.
 */
export function normalizeProviderId(providerId: string | undefined): string | undefined {
	if (!providerId) return undefined;
	return PROVIDER_LOOKUP.get(providerId)?.canonicalProviderId ?? providerId;
}

/**
 * Resolve a provider descriptor from a canonical ID or alias.
 */
export function getProviderDescriptor(providerId: string | undefined): ProviderDescriptor | undefined {
	if (!providerId) return undefined;
	return PROVIDER_LOOKUP.get(providerId);
}

/**
 * Return every known provider descriptor in catalog order.
 */
export function listProviderDescriptors(): ProviderDescriptor[] {
	return [...PROVIDER_CATALOG];
}

/**
 * Read provider config using canonical IDs and accepted aliases.
 */
export function getProviderConfig(
	config: KoshaConfig | undefined,
	providerId: string | undefined,
): NonNullable<KoshaConfig["providers"]>[string] | undefined {
	if (!config?.providers || !providerId) return undefined;

	const descriptor = getProviderDescriptor(providerId);
	if (!descriptor) {
		return config.providers[providerId];
	}

	return config.providers[descriptor.providerId] ??
		config.providers[descriptor.canonicalProviderId] ??
		descriptor.aliases.map((alias) => config.providers?.[alias]).find(Boolean);
}

/** Return true when model execution through this provider needs auth. */
export function providerExecutionCredentialRequired(
	descriptor: Pick<ProviderDescriptor, "credentialRequired" | "executionCredentialRequired">,
): boolean {
	return descriptor.executionCredentialRequired ?? descriptor.credentialRequired;
}

/**
 * Return the curated prompt-cache behavior for a provider, or `undefined`
 * if the policy has not been curated yet.
 */
export function getProviderCacheBehavior(providerId: string | undefined): ProviderCacheBehavior | undefined {
	return getProviderDescriptor(providerId)?.cacheBehavior;
}

/**
 * True when the provider is a local runtime.
 */
export function isLocalProvider(providerId: string | undefined): boolean {
	return getProviderDescriptor(providerId)?.isLocal ?? false;
}
