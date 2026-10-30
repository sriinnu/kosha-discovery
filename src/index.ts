/**
 * kosha-discovery — Public API barrel export.
 *
 * Re-exports every public class, type, and factory function so that
 * consumers can import from a single `"kosha-discovery"` entry point.
 * @module
 */

export { AliasResolver, DEFAULT_ALIASES } from "./aliases.js";
export { KoshaCache } from "./cache.js";
export type { CatalogEnvelope, CatalogReport, CatalogSource, ResolvedCatalogSource } from "./catalog-source.js";
export {
	buildCatalogEnvelope,
	CATALOG_FILE_ENV,
	CATALOG_KIND,
	CATALOG_SCHEMA_VERSION,
	CATALOG_SOURCE_ENV,
	CATALOG_SOURCES,
	describeCatalog,
	resolveCatalogSource,
} from "./catalog-source.js";
export type { ClaudeEffort, ClaudeGeneration, SamplingSupport } from "./claude-generation.js";
export {
	claudeEffortLadder,
	claudeSamplingSupport,
	claudeSupportsForcedToolChoice,
	claudeSupportsNativeJsonSchema,
	claudeSupportsPrefill,
	parseClaudeGeneration,
} from "./claude-generation.js";
export type { ActualUsageCost, CostEstimate, LedgerEntry, UsageShape } from "./cost.js";
export {
	actualCostFromUsage,
	appendLedgerEntry,
	DEFAULT_LEDGER_PATH,
	estimateRequestCost,
	isRequestRow,
	ledgerRowUsd,
	readMonthlyBudgetUsd,
	readSpendForMonth,
	readTenantBudgetUsd,
} from "./cost.js";
export type {
	DiscoveryBindingHintsV1,
	DiscoveryBindingQuery,
	DiscoveryChangeV1,
	DiscoveryCheapestCandidateV1,
	DiscoveryCheapestResultV1,
	DiscoveryCredentialPrompt,
	DiscoveryDeltaV1,
	DiscoveryHealthRecord,
	DiscoveryModelV1,
	DiscoveryProviderV1,
	DiscoveryRoleDefinition,
	DiscoverySnapshotV1,
	TrustedCapability,
} from "./discovery-contract.js";
export {
	DISCOVERY_SCHEMA_VERSION,
	discoveryRoles,
	makeModelKey,
	rawCapabilitiesForModel,
	trustedCapabilitiesForModel,
} from "./discovery-contract.js";
export { inferParallelToolCalls, inferStructuredOutputModes, inferToolDialect } from "./model-features.js";
export { extractModelVersion, extractOriginProvider, normalizeModelId } from "./normalize.js";
export type { ProviderDescriptor } from "./provider-catalog.js";
export {
	getProviderDescriptor,
	isLocalProvider,
	listProviderDescriptors,
	normalizeProviderId,
	PROVIDER_CATALOG,
} from "./provider-catalog.js";
export { ModelRegistry } from "./registry.js";
export type { RankedRoute, RouteHealth, RouteStrategy } from "./registry-routing.js";
export {
	parseRouteStrategy,
	ROUTE_STRATEGIES,
} from "./registry-routing.js";
export type {
	NormalizedTokenUsage,
	TallyCall,
	TallyModelSubtotal,
	TallyResult,
	TokenUsage,
	UsdCostBreakdown,
} from "./tally.js";
export { estimateUsdCost, normalizeTokenUsage, tallyCosts } from "./tally.js";
export { inferTokenizerFamily } from "./tokenizer-family.js";
export type {
	CapabilitySummary,
	CheapestModelMatch,
	CheapestModelOptions,
	CheapestModelResult,
	ComputeTarget,
	CredentialResult,
	DiscoveryError,
	DiscoveryOptions,
	Enricher,
	KoshaConfig,
	LatestDiscoveryOptions,
	LatestDiscoveryResult,
	LocalRuntimeMetadata,
	ModelCard,
	ModelMode,
	ModelPricing,
	ModelRoleCard,
	ModelRouteInfo,
	ModelStatus,
	PricingMetric,
	ProviderCredentialPrompt,
	ProviderDiscoverer,
	ProviderInfo,
	ProviderOrigin,
	ProviderRoleInfo,
	ProviderTransport,
	RoleQueryOptions,
	StructuredOutputMode,
	ToolDialect,
} from "./types.js";
export type {
	AnthropicContentBlock,
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicStreamTranslation,
	AnthropicUsage,
	OpenAIChatRequest,
	OpenAIChatResponse,
	OpenAIToolCall,
	OpenAIUsage,
	WireTranslation,
} from "./wire-anthropic.js";
export {
	coerceOpenAIChatRequest,
	toOpenAIUsage,
	translateAnthropicStreamToOpenAI,
	translateAnthropicToOpenAI,
	translateOpenAIToAnthropic,
	translateOpenAIToAnthropicWithNotes,
	UnsupportedWireContentError,
} from "./wire-anthropic.js";

/**
 * Convenience factory: creates a ModelRegistry and runs discovery in one call.
 *
 * Automatically loads config from `~/.kosharc.json` and `kosha.config.json`
 * (if they exist) before applying any explicit overrides.
 *
 * @example
 * ```ts
 * const kosha = await createKosha();
 * const models = kosha.models({ mode: "chat" });
 * ```
 */
export async function createKosha(
	config?: import("./types.js").KoshaConfig,
): Promise<import("./registry.js").ModelRegistry> {
	const { ModelRegistry: Registry } = await import("./registry.js");
	const merged = await Registry.loadConfigFile(config);
	const registry = new Registry(merged);
	await registry.discover();
	return registry;
}
