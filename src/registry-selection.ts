/**
 * kosha-discovery — Discovery-plane selection helpers.
 *
 * I keep execution-binding hints and cheapest-candidate projections separate
 * from the legacy query layer because these are discovery-plane outputs, not
 * final routing policy.
 * @module
 */

import {
	DISCOVERY_SCHEMA_VERSION,
	trustedCapabilitiesForModel,
} from "./discovery-contract.js";
import type {
	DiscoveryBindingHintsV1,
	DiscoveryBindingQuery,
	DiscoveryCheapestResultV1,
	TrustedCapability,
} from "./discovery-contract.js";
import { normalizeProviderId } from "./provider-catalog.js";
import {
	computeModelScore,
	defaultPricingMetric,
	normalizeLimit,
	registryModels,
	registryProviderDescriptor,
} from "./registry-query.js";
import type { RegistryState } from "./registry-state.js";
import type { ModelCard, ModelMode, PricingMetric } from "./types.js";

/**
 * Return ranked cheapest candidates for the v1 discovery plane.
 */
export function registryCheapestCandidates(
	state: RegistryState,
	query: DiscoveryBindingQuery = {},
): DiscoveryCheapestResultV1 {
	const priceMetric = query.priceMetric ?? defaultPricingMetric({
		mode: query.mode as ModelMode | undefined,
		role: query.role,
		capability: query.capability,
	});
	const candidates = discoveryCandidateModels(state, query).map(({ model, descriptor }) => ({
		model,
		descriptor,
		score: computeModelScore(model, priceMetric as PricingMetric, 1, 1),
	}));
	const priced = candidates.filter((entry) => entry.score !== undefined).sort((a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY));
	const unpriced = candidates.filter((entry) => entry.score === undefined);

	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		query: discoveryQueryRecord(query),
		candidates: candidates.length,
		pricedCandidates: priced.length,
		skippedNoPricing: candidates.length - priced.length,
		priceMetric,
		matches: [...priced, ...unpriced].slice(0, normalizeLimit(query.limit)).map(({ model, descriptor, score }) => ({
			modelId: model.id,
			providerId: model.provider,
			canonicalProviderId: descriptor.canonicalProviderId,
			score: score ?? null,
			priceMetric,
			capabilities: trustedCapabilitiesForModel(model, descriptor),
		})),
	};
}

/**
 * Return selection hints that Chitragupta can turn into an execution binding.
 */
export function registryExecutionBindingHints(
	state: RegistryState,
	query: DiscoveryBindingQuery = {},
): DiscoveryBindingHintsV1 {
	const preferLocalProviders = query.preferLocalProviders ?? false;
	const allowCrossProvider = query.allowCrossProvider ?? true;
	const priceMetric = (query.priceMetric ?? defaultPricingMetric({
		mode: query.mode as ModelMode | undefined,
		role: query.role,
		capability: query.capability,
	})) as PricingMetric;
	const routes = discoveryCandidateModels(state, query).map(({ model, descriptor }) => ({
		model,
		descriptor,
		isLocal: descriptor.isLocal,
		isDirect: normalizeProviderId(model.originProvider) === descriptor.canonicalProviderId,
		price: computeModelScore(model, priceMetric, 1, 1),
	})).sort((a, b) =>
		// I keep the sort deterministic so consumers get stable binding hints across identical snapshots.
		(preferLocalProviders ? Number(b.isLocal) - Number(a.isLocal) : 0) ||
		Number(b.isDirect) - Number(a.isDirect) ||
		(a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY) ||
		a.descriptor.canonicalProviderId.localeCompare(b.descriptor.canonicalProviderId) ||
		a.model.id.localeCompare(b.model.id)
	);

	const selected = routes[0];
	const scopedRoutes = !allowCrossProvider && selected ? routes.filter((route) => route.model.provider === selected.model.provider) : routes;
	const preferredRoutes = scopedRoutes.slice(0, normalizeLimit(query.limit));

	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		query: discoveryQueryRecord(query),
		selectedModelId: selected?.model.id ?? null,
		selectedProviderId: selected?.model.provider ?? null,
		candidateModelIds: Array.from(new Set(scopedRoutes.map((route) => route.model.id))),
		preferredModelIds: Array.from(new Set(preferredRoutes.map((route) => route.model.id))),
		preferredProviderIds: Array.from(new Set(preferredRoutes.map((route) => route.model.provider))),
		preferLocalProviders,
		allowCrossProvider,
	};
}

/**
 * Return models that satisfy a discovery-plane query.
 */
export function discoveryCandidateModels(state: RegistryState, query: DiscoveryBindingQuery) {
	return registryModels(state, {
		provider: normalizeProviderId(query.provider),
		originProvider: normalizeProviderId(query.originProvider),
		mode: query.mode as ModelMode | undefined,
	}).flatMap((model) => {
		const descriptor = registryProviderDescriptor(state, model.provider, state.providerMap.get(model.provider));
		return modelMatchesDiscoveryQuery(model, descriptor, query) ? [{ model, descriptor }] : [];
	});
}

/**
 * Serialize a binding query into the stable v1 JSON shape.
 */
export function discoveryQueryRecord(query: DiscoveryBindingQuery): Record<string, string | number | boolean | null> {
	return {
		role: query.role ?? null,
		capability: query.capability ?? null,
		provider: normalizeProviderId(query.provider) ?? query.provider ?? null,
		originProvider: normalizeProviderId(query.originProvider) ?? query.originProvider ?? null,
		mode: query.mode ?? null,
		limit: query.limit ?? null,
		priceMetric: query.priceMetric ?? null,
		preferLocalProviders: query.preferLocalProviders ?? null,
		allowCrossProvider: query.allowCrossProvider ?? null,
	};
}

function modelMatchesDiscoveryQuery(
	model: ModelCard,
	descriptor: ReturnType<typeof registryProviderDescriptor>,
	query: DiscoveryBindingQuery,
): boolean {
	const capabilities = trustedCapabilitiesForModel(model, descriptor);
	// I only trust normalized capabilities here so free-form discoverer tags do not leak into route semantics.
	const capability = normalizeTrustedCapabilityToken(query.capability);
	if (capability && !capabilities.includes(capability)) return false;
	return !query.role || roleRequirements(query.role).every((requiredCapability) => capabilities.includes(requiredCapability));
}

function roleRequirements(role: string): TrustedCapability[] {
	switch (role.trim().toLowerCase().replace(/[\s-]+/g, "_")) {
		case "tool_use":
		case "tools":
		case "functions":
			return ["chat", "function_calling"];
		case "embeddings":
		case "embedding":
			return ["embeddings"];
		case "vision":
			return ["chat", "vision"];
		case "rerank":
			return ["rerank"];
		case "local":
		case "local_exec":
			return ["local_exec"];
		default:
			return [normalizeTrustedCapabilityToken(role) ?? "chat"];
	}
}

function normalizeTrustedCapabilityToken(value: string | undefined): TrustedCapability | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	const map: Record<string, TrustedCapability> = {
		chat: "chat",
		embedding: "embeddings",
		embeddings: "embeddings",
		function_calling: "function_calling",
		tool_use: "function_calling",
		tools: "function_calling",
		vision: "vision",
		rerank: "rerank",
		structured_output: "structured_output",
		streaming: "streaming",
		long_context: "long_context",
		local_exec: "local_exec",
		local: "local_exec",
		code: "code_generation",
		code_generation: "code_generation",
		reasoning: "reasoning",
		low_latency: "low_latency",
		cheap_inference: "cheap_inference",
	};
	return map[normalized];
}
