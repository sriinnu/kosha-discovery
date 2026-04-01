/**
 * kosha-discovery — Canonical provider catalog.
 *
 * I keep provider identity, aliases, transport, credential requirements,
 * and default base URLs in one place so discovery, credentials, and the
 * versioned schema do not drift apart.
 * @module
 */

import type { KoshaConfig, ProviderOrigin, ProviderTransport } from "./types.js";

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
	/** Whether the provider normally requires credentials. */
	credentialRequired: boolean;
	/** Environment variables that satisfy the provider credential requirement. */
	credentialEnvVars: string[];
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
		credentialEnvVars: ["OPENROUTER_API_KEY"],
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

/**
 * True when the provider is a local runtime.
 */
export function isLocalProvider(providerId: string | undefined): boolean {
	return getProviderDescriptor(providerId)?.isLocal ?? false;
}
