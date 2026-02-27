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
export { extractModelVersion, extractOriginProvider, normalizeModelId } from "./normalize.js";
export type {
	ModelCard,
	ProviderInfo,
	ProviderRoleInfo,
	DiscoveryError,
	DiscoveryOptions,
	KoshaConfig,
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
