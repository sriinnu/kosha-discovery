/**
 * kosha-discovery — Public API barrel export.
 *
 * Re-exports every public class, type, and factory function so that
 * consumers can import from a single `"kosha-discovery"` entry point.
 * @module
 */

export { ModelRegistry } from "./registry.js";
export { AliasResolver, DEFAULT_ALIASES } from "./aliases.js";
export { KoshaCache } from "./cache.js";
export {
	DISCOVERY_SCHEMA_VERSION,
	discoveryRoles,
	makeModelKey,
	rawCapabilitiesForModel,
	trustedCapabilitiesForModel,
} from "./discovery-contract.js";
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
export { extractModelVersion, extractOriginProvider, normalizeModelId } from "./normalize.js";
export {
	getProviderDescriptor,
	isLocalProvider,
	listProviderDescriptors,
	normalizeProviderId,
	PROVIDER_CATALOG,
} from "./provider-catalog.js";
export type { ProviderDescriptor } from "./provider-catalog.js";
export type {
	ComputeTarget,
	LocalRuntimeMetadata,
	ModelCard,
	ProviderInfo,
	ProviderRoleInfo,
	DiscoveryError,
	DiscoveryOptions,
	KoshaConfig,
	LatestDiscoveryOptions,
	LatestDiscoveryResult,
	ModelMode,
	ModelPricing,
	ModelRoleCard,
	RoleQueryOptions,
	CheapestModelOptions,
	CheapestModelMatch,
	CheapestModelResult,
	ProviderCredentialPrompt,
	PricingMetric,
	ModelRouteInfo,
	CapabilitySummary,
	CredentialResult,
	ProviderDiscoverer,
	Enricher,
	ProviderOrigin,
	ProviderTransport,
} from "./types.js";

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
export async function createKosha(config?: import("./types.js").KoshaConfig): Promise<import("./registry.js").ModelRegistry> {
	const { ModelRegistry: Registry } = await import("./registry.js");
	const merged = await Registry.loadConfigFile(config);
	const registry = new Registry(merged);
	await registry.discover();
	return registry;
}
