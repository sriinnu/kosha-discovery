/**
 * kosha-discovery — Versioned discovery contract helpers.
 *
 * I keep the v1 schema, trusted capability taxonomy, and lightweight
 * heuristics here so the registry can stay focused on orchestration.
 * @module
 */

import type { ModelCard, ModelPricing } from "./types.js";
import type { ProviderDescriptor } from "./provider-catalog.js";

/** Stable schema version exposed to Chitragupta and other daemon consumers. */
export const DISCOVERY_SCHEMA_VERSION = 1;

/** Trusted capability taxonomy surfaced by the v1 discovery contract. */
export type TrustedCapability =
	| "chat"
	| "function_calling"
	| "embeddings"
	| "vision"
	| "rerank"
	| "structured_output"
	| "streaming"
	| "long_context"
	| "local_exec"
	| "code_generation"
	| "reasoning"
	| "low_latency"
	| "cheap_inference";

/** Normalized role hints exposed by the v1 schema. */
export interface DiscoveryRoleDefinition {
	/** Stable role identifier. */
	roleId: string;
	/** Capabilities required for the role to be viable. */
	requiredCapabilities: TrustedCapability[];
	/** Capabilities that improve suitability but are not mandatory. */
	preferredCapabilities: TrustedCapability[];
	/** Short human-readable hint for consumers. */
	suitabilityHint: string;
}

/** Credential prompt shape exposed in the v1 schema. */
export interface DiscoveryCredentialPrompt {
	providerId: string;
	providerName: string;
	required: boolean;
	envVars: string[];
	message: string;
}

/** Stable provider shape emitted by the v1 discovery snapshot. */
export interface DiscoveryProviderV1 {
	providerId: string;
	canonicalProviderId: string;
	aliases: string[];
	name: string;
	origin: string;
	isLocal: boolean;
	transport: string;
	authenticated: boolean;
	credentialSource: string | null;
	credentialsPresent: boolean;
	credentialsRequired: boolean;
	credentialEnvVars: string[];
	modelCount: number;
	lastRefreshed: number | null;
	baseUrl: string;
}

/** Stable model shape emitted by the v1 discovery snapshot. */
export interface DiscoveryModelV1 {
	key: string;
	modelId: string;
	name: string;
	providerId: string;
	canonicalProviderId: string;
	originProviderId: string;
	mode: string;
	capabilities: TrustedCapability[];
	rawCapabilities: string[];
	contextWindow: number | null;
	maxOutputTokens: number | null;
	pricing: ModelPricing | null;
	originPricing?: ModelPricing | null;
	dimensions: number | null;
	maxInputTokens: number | null;
	discoveredAt: number;
	source: string;
	aliases: string[];
	region: string | null;
	projectId: string | null;
	runtimeFamily: string | null;
	tokenizerFamily: string | null;
	quantization: string | null;
	memoryFootprintBytes: number | null;
	computeTarget: string | null;
	supportsStructuredOutput: boolean | null;
	supportsStreaming: boolean | null;
}

/** Normalized provider health exposed by the v1 discovery snapshot. */
export interface DiscoveryHealthRecord {
	providerId: string;
	state: "healthy" | "degraded" | "down" | "auth_error" | "throttled" | "unknown";
	failureCount: number;
	lastError: string | null;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	latencyClass: "low" | "medium" | "high" | "timeout" | "unknown";
	timeoutRate: number;
	rateLimitState: "ok" | "throttled" | "unknown";
	circuitState: "closed" | "open" | "half-open";
}

/** Full v1 discovery snapshot. */
export interface DiscoverySnapshotV1 {
	schemaVersion: number;
	discoveredAt: number | null;
	cursor: string;
	providers: DiscoveryProviderV1[];
	models: DiscoveryModelV1[];
	roles: DiscoveryRoleDefinition[];
	health: DiscoveryHealthRecord[];
	credentialPrompts: DiscoveryCredentialPrompt[];
}

/** Entity kinds that can appear in a delta stream. */
export type DiscoveryChangeEntity = "provider" | "model" | "health" | "credential_prompt";

/** Individual change item inside a delta batch. */
export interface DiscoveryChangeV1 {
	entity: DiscoveryChangeEntity;
	action: "upsert" | "remove";
	key: string;
	value: DiscoveryProviderV1 | DiscoveryModelV1 | DiscoveryHealthRecord | DiscoveryCredentialPrompt | null;
}

/** Aggregate delta response used by polling and live watch. */
export interface DiscoveryDeltaV1 {
	schemaVersion: number;
	sinceCursor: string | null;
	cursor: string;
	changedAt: number | null;
	resetRequired: boolean;
	changes: DiscoveryChangeV1[];
}

/** Stable cheapest-candidate match used by the v1 debug/library surface. */
export interface DiscoveryCheapestCandidateV1 {
	modelId: string;
	providerId: string;
	canonicalProviderId: string;
	score: number | null;
	priceMetric: string;
	capabilities: TrustedCapability[];
}

/** Cheapest-candidate response for a normalized query. */
export interface DiscoveryCheapestResultV1 {
	schemaVersion: number;
	query: Record<string, string | number | boolean | null>;
	candidates: number;
	pricedCandidates: number;
	skippedNoPricing: number;
	priceMetric: string;
	matches: DiscoveryCheapestCandidateV1[];
}

/** Binding query used by the additive v1 selection-hints surface. */
export interface DiscoveryBindingQuery {
	role?: string;
	capability?: string;
	provider?: string;
	originProvider?: string;
	mode?: string;
	limit?: number;
	priceMetric?: string;
	preferLocalProviders?: boolean;
	allowCrossProvider?: boolean;
}

/** Query-scoped discovery hints used to build Chitragupta bindings. */
export interface DiscoveryBindingHintsV1 {
	schemaVersion: number;
	query: Record<string, string | number | boolean | null>;
	selectedModelId: string | null;
	selectedProviderId: string | null;
	candidateModelIds: string[];
	preferredModelIds: string[];
	preferredProviderIds: string[];
	preferLocalProviders: boolean;
	allowCrossProvider: boolean;
}

/** Stable role definitions shipped with the v1 schema. */
export const DISCOVERY_ROLE_DEFINITIONS: readonly DiscoveryRoleDefinition[] = [
	{
		roleId: "chat",
		requiredCapabilities: ["chat"],
		preferredCapabilities: ["streaming"],
		suitabilityHint: "General conversational generation.",
	},
	{
		roleId: "tool_use",
		requiredCapabilities: ["chat", "function_calling"],
		preferredCapabilities: ["structured_output"],
		suitabilityHint: "Best for agent loops and tool invocation.",
	},
	{
		roleId: "embeddings",
		requiredCapabilities: ["embeddings"],
		preferredCapabilities: ["cheap_inference", "low_latency"],
		suitabilityHint: "Vectorization and semantic retrieval.",
	},
	{
		roleId: "vision",
		requiredCapabilities: ["chat", "vision"],
		preferredCapabilities: ["streaming"],
		suitabilityHint: "Multimodal prompts with image understanding.",
	},
	{
		roleId: "rerank",
		requiredCapabilities: ["rerank"],
		preferredCapabilities: ["low_latency"],
		suitabilityHint: "Document or passage reranking pipelines.",
	},
	{
		roleId: "local_exec",
		requiredCapabilities: ["local_exec"],
		preferredCapabilities: ["low_latency", "cheap_inference"],
		suitabilityHint: "Local-first inference on the current machine.",
	},
] as const;

const CODE_PATTERNS = ["code", "coder", "codellama", "codestral", "starcoder"];
const REASONING_PATTERNS = ["reason", "deep-research", "deep_research", "o1", "o3", "o4"];
const LOW_LATENCY_PROVIDER_IDS = new Set(["groq", "cerebras", "ollama", "llama.cpp"]);

/**
 * Build a stable composite key for a model route.
 */
export function makeModelKey(model: Pick<ModelCard, "provider" | "id">, descriptor: ProviderDescriptor): string {
	return `${descriptor.canonicalProviderId}:${model.id}`;
}

/**
 * Return the raw capability list that a discoverer originally emitted.
 */
export function rawCapabilitiesForModel(model: ModelCard): string[] {
	return [...new Set((model.rawCapabilities ?? model.capabilities).map((capability) => capability.trim()))].sort();
}

/**
 * Normalize free-form model metadata into the trusted capability taxonomy.
 *
 * I keep the heuristics intentionally conservative. When I cannot infer a
 * capability with reasonable confidence, I leave it out of the trusted set.
 */
export function trustedCapabilitiesForModel(model: ModelCard, descriptor: ProviderDescriptor): TrustedCapability[] {
	const caps = new Set<TrustedCapability>();
	const rawCaps = rawCapabilitiesForModel(model).map((capability) => capability.toLowerCase().replace(/[\s-]+/g, "_"));
	const lowerId = model.id.toLowerCase();

	if (model.mode === "chat" || rawCaps.includes("chat")) caps.add("chat");
	if (model.mode === "embedding" || rawCaps.includes("embedding") || rawCaps.includes("embeddings")) caps.add("embeddings");
	if (rawCaps.includes("function_calling")) caps.add("function_calling");
	if (rawCaps.includes("vision")) caps.add("vision");
	if (rawCaps.includes("rerank") || lowerId.includes("rerank")) caps.add("rerank");
	if (descriptor.isLocal) caps.add("local_exec");

	// Chat-capable providers almost universally expose streaming, so I surface it
	// when the model is chat-oriented or the local runtime explicitly advertises it.
	if (model.localRuntime?.supportsStreaming === true || model.mode === "chat") caps.add("streaming");
	if (model.localRuntime?.supportsStructuredOutput === true) caps.add("structured_output");
	if ((model.contextWindow ?? 0) >= 100_000) caps.add("long_context");
	if (rawCaps.includes("code") || CODE_PATTERNS.some((pattern) => lowerId.includes(pattern))) caps.add("code_generation");
	if (rawCaps.includes("nlu") || REASONING_PATTERNS.some((pattern) => lowerId.includes(pattern))) caps.add("reasoning");
	if (LOW_LATENCY_PROVIDER_IDS.has(descriptor.canonicalProviderId) || descriptor.isLocal) caps.add("low_latency");
	if (descriptor.isLocal || isCheapPricing(model.pricing)) caps.add("cheap_inference");

	return [...caps].sort();
}

/**
 * Return stable role definitions for the v1 snapshot.
 */
export function discoveryRoles(): DiscoveryRoleDefinition[] {
	return [...DISCOVERY_ROLE_DEFINITIONS];
}

function isCheapPricing(pricing: ModelPricing | undefined): boolean {
	if (!pricing) return false;
	return pricing.inputPerMillion <= 1 && pricing.outputPerMillion <= 4;
}
