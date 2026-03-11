/**
 * kosha-discovery — Core query helpers for ModelRegistry.
 *
 * I keep model lookup, role filtering, capability aggregation, and cheapest
 * route selection here so the registry façade can stay under the file-size
 * policy while preserving the public API.
 * @module
 */

import type {
	CapabilitySummary,
	CheapestModelMatch,
	CheapestModelOptions,
	CheapestModelResult,
	ModelCard,
	ModelMode,
	ModelRouteInfo,
	PricingMetric,
	ProviderCredentialPrompt,
	ProviderInfo,
	ProviderRoleInfo,
	RoleQueryOptions,
} from "./types.js";
import { extractModelVersion, extractOriginProvider, normalizeModelId } from "./normalize.js";
import { getProviderDescriptor, isLocalProvider, normalizeProviderId } from "./provider-catalog.js";
import type { RegistryState } from "./registry-state.js";

const ROLE_ALIASES: Record<string, string> = {
	embeddings: "embedding",
	vector: "embedding",
	vectors: "embedding",
	images: "image_generation",
	imagegen: "image_generation",
	image_generation: "image_generation",
	image_generation_model: "image_generation",
	stt: "speech_to_text",
	transcription: "speech_to_text",
	tts: "text_to_speech",
	speech: "audio",
	tool_use: "function_calling",
	tools: "function_calling",
	functions: "function_calling",
	functioncalling: "function_calling",
	prompt_cache: "prompt_caching",
};

const MODE_ALIASES: Record<string, ModelMode> = {
	chat: "chat",
	completion: "chat",
	completions: "chat",
	embedding: "embedding",
	image: "image",
	image_generation: "image",
	audio: "audio",
	speech_to_text: "audio",
	text_to_speech: "audio",
	moderation: "moderation",
	safety: "moderation",
	rerank: "rerank",
};

/**
 * Return a stable provider descriptor, even for synthetic test providers.
 */
export function registryProviderDescriptor(state: RegistryState, providerId: string, providerInfo?: ProviderInfo) {
	return getProviderDescriptor(providerId) ?? {
		providerId,
		canonicalProviderId: providerId,
		aliases: [],
		name: providerInfo?.name ?? providerId,
		origin: isLocalProvider(providerId) ? "local" : "direct",
		isLocal: isLocalProvider(providerId),
		transport: "native-http" as const,
		defaultBaseUrl: providerInfo?.baseUrl ?? "",
		credentialRequired: false,
		credentialEnvVars: [],
	};
}

/**
 * Normalize a role or capability token for routing and filtering.
 */
export function normalizeRoleToken(value: string): string {
	const token = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	return ROLE_ALIASES[token] ?? token;
}

/**
 * Return the deduplicated role list for a single model.
 */
export function modelRoles(model: ModelCard): string[] {
	return Array.from(new Set([model.mode, ...model.capabilities.map((capability) => normalizeRoleToken(capability))]));
}

/**
 * Check whether a model satisfies a role or capability query.
 */
export function modelSupportsRole(model: ModelCard, roleOrCapability: string): boolean {
	const token = normalizeRoleToken(roleOrCapability);
	if (modelRoles(model).includes(token)) return true;

	const mode = MODE_ALIASES[token];
	if (mode && model.mode === mode) return true;
	return token === "image_generation" && model.mode === "image";
}

/**
 * List models with provider-aware deduplication and optional filters.
 */
export function registryModels(
	state: RegistryState,
	filter?: { provider?: string; originProvider?: string; mode?: ModelMode; capability?: string },
): ModelCard[] {
	const normalizedProvider = normalizeProviderId(filter?.provider);
	const normalizedOriginProvider = normalizeProviderId(filter?.originProvider);
	const seen = new Set<string>();
	const result: ModelCard[] = [];

	for (const providerInfo of state.providerMap.values()) {
		if (normalizedProvider && providerInfo.id !== normalizedProvider) continue;

		for (const model of providerInfo.models) {
			// I dedupe by provider+model so the same upstream model can still appear through different routes.
			const dedupKey = `${model.provider}:${model.id}`;
			if (seen.has(dedupKey)) continue;
			if (normalizedOriginProvider && normalizeProviderId(model.originProvider) !== normalizedOriginProvider) continue;
			if (filter?.mode && model.mode !== filter.mode) continue;
			if (filter?.capability && !model.capabilities.includes(filter.capability)) continue;

			seen.add(dedupKey);
			result.push(model);
		}
	}

	return result;
}

/**
 * Build the provider -> model -> roles matrix used by the legacy API.
 */
export function registryProviderRoles(state: RegistryState, filter?: RoleQueryOptions): ProviderRoleInfo[] {
	const normalizedProvider = normalizeProviderId(filter?.provider);
	const normalizedOriginProvider = normalizeProviderId(filter?.originProvider);
	const normalizedCapability = filter?.capability ? normalizeRoleToken(filter.capability) : undefined;
	const providers: ProviderRoleInfo[] = [];

	for (const providerInfo of state.providerMap.values()) {
		if (normalizedProvider && providerInfo.id !== normalizedProvider) continue;

		const models = providerInfo.models.filter((model) => {
			if (normalizedOriginProvider && normalizeProviderId(model.originProvider) !== normalizedOriginProvider) return false;
			if (filter?.mode && model.mode !== filter.mode) return false;
			if (normalizedCapability && !modelSupportsRole(model, normalizedCapability)) return false;
			if (filter?.role && !modelSupportsRole(model, filter.role)) return false;
			return true;
		}).map((model) => ({
			id: model.id,
			name: model.name,
			provider: model.provider,
			originProvider: model.originProvider,
			mode: model.mode,
			roles: modelRoles(model),
			pricing: model.pricing,
		}));

		if (models.length === 0) continue;
		providers.push({
			id: providerInfo.id,
			name: providerInfo.name,
			authenticated: providerInfo.authenticated,
			credentialSource: providerInfo.credentialSource,
			models: models.sort((a, b) => a.id.localeCompare(b.id)),
		});
	}

	return providers.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Return prompts for currently discovered providers missing required credentials.
 */
export function registryMissingCredentialPrompts(state: RegistryState, providerIds?: string[]): ProviderCredentialPrompt[] {
	const normalizedIds = providerIds?.map((providerId) => normalizeProviderId(providerId) ?? providerId);
	const providers = providerIds && providerIds.length > 0
		? normalizedIds?.flatMap((providerId) => {
			const provider = state.providerMap.get(providerId ?? "");
			return provider ? [provider] : [];
		}) ?? []
		: Array.from(state.providerMap.values());
	const prompts: ProviderCredentialPrompt[] = [];

	for (const provider of providers) {
		const descriptor = registryProviderDescriptor(state, provider.id, provider);
		if (!descriptor.credentialRequired || provider.authenticated) continue;
		const envHint = descriptor.credentialEnvVars.length > 0 ? `Set ${descriptor.credentialEnvVars.join(" or ")}` : "Configure credentials";
		prompts.push({
			providerId: descriptor.providerId,
			providerName: descriptor.name,
			required: true,
			envVars: descriptor.credentialEnvVars,
			message: `${envHint} to enable ${descriptor.name} model discovery.`,
		});
	}

	return prompts.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/**
 * Rank the cheapest models for a normalized role/mode query.
 */
export function registryCheapestModels(state: RegistryState, options?: CheapestModelOptions): CheapestModelResult {
	const capability = options?.capability ? normalizeRoleToken(options.capability) : undefined;
	const candidates = registryModels(state, {
		provider: options?.provider,
		originProvider: options?.originProvider,
		mode: options?.mode,
	}).filter((model) => (!capability || modelSupportsRole(model, capability)) && (!options?.role || modelSupportsRole(model, options.role)));
	const priceMetric = options?.priceMetric ?? defaultPricingMetric(options);
	const ranked: CheapestModelMatch[] = [];
	const unpriced: CheapestModelMatch[] = [];

	for (const model of candidates) {
		const score = computeModelScore(model, priceMetric, options?.inputWeight ?? 1, options?.outputWeight ?? 1);
		if (score === undefined) {
			if (options?.includeUnpriced) unpriced.push({ model, score: undefined, priceMetric });
			continue;
		}
		ranked.push({ model, score, priceMetric });
	}

	ranked.sort((a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY) || a.model.provider.localeCompare(b.model.provider) || a.model.id.localeCompare(b.model.id));
	unpriced.sort((a, b) => a.model.provider.localeCompare(b.model.provider) || a.model.id.localeCompare(b.model.id));
	const scopedProviderIds = options?.provider ? [options.provider] : Array.from(state.providerMap.values()).map((provider) => provider.id);

	return {
		matches: [...ranked, ...unpriced].slice(0, normalizeLimit(options?.limit)),
		candidates: candidates.length,
		pricedCandidates: ranked.length,
		skippedNoPricing: candidates.length - ranked.length,
		priceMetric,
		missingCredentials: registryMissingCredentialPrompts(state, scopedProviderIds),
	};
}

/**
 * Find every provider route for a normalized model identifier.
 */
export function registryModelRoutes(state: RegistryState, modelId: string): ModelCard[] {
	const targetNorm = normalizeModelId(modelId).toLowerCase();
	const routes = registryModels(state).filter((model) => normalizeModelId(model.id).toLowerCase() === targetNorm);
	return routes.sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Enrich raw routes with preferred/direct metadata for legacy consumers.
 */
export function registryModelRouteInfo(state: RegistryState, modelId: string): ModelRouteInfo[] {
	const info = registryModelRoutes(state, modelId).map((model) => {
		const resolvedOrigin = model.originProvider ?? extractOriginProvider(model.id) ?? model.provider;
		return {
			model,
			provider: model.provider,
			originProvider: resolvedOrigin,
			baseUrl: state.providerMap.get(model.provider)?.baseUrl,
			version: extractModelVersion(model.id),
			isDirect: model.provider === resolvedOrigin,
			isPreferred: false,
		};
	});

	if (info.length === 0) return info;
	const directRoutes = info.filter((route) => route.isDirect);
	if (directRoutes.length > 0) {
		// I prefer direct-origin routes first because they are usually the clearest default for operators.
		for (const route of directRoutes) route.isPreferred = true;
	} else {
		const priced = info.filter((route) => route.model.pricing && Number.isFinite(route.model.pricing.inputPerMillion) && Number.isFinite(route.model.pricing.outputPerMillion));
		(priced.length > 0 ? priced.sort((a, b) => ((a.model.pricing?.inputPerMillion ?? 0) + (a.model.pricing?.outputPerMillion ?? 0)) - ((b.model.pricing?.inputPerMillion ?? 0) + (b.model.pricing?.outputPerMillion ?? 0)) || a.provider.localeCompare(b.provider)) : info)[0].isPreferred = true;
	}

	return info.sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred) || Number(b.isDirect) - Number(a.isDirect) || a.provider.localeCompare(b.provider));
}

/**
 * Aggregate capability statistics across all discovered models.
 */
export function registryCapabilities(state: RegistryState, filter?: { provider?: string }): CapabilitySummary[] {
	const capabilityMap = new Map<string, { models: Set<string>; providers: Set<string>; modes: Set<ModelMode>; exampleModelId?: string }>();

	for (const model of registryModels(state, { provider: filter?.provider })) {
		for (const role of modelRoles(model)) {
			const entry = capabilityMap.get(role) ?? { models: new Set(), providers: new Set(), modes: new Set(), exampleModelId: model.id };
			entry.models.add(`${model.provider}:${model.id}`);
			entry.providers.add(model.provider);
			entry.modes.add(model.mode);
			capabilityMap.set(role, entry);
		}
	}

	return Array.from(capabilityMap.entries()).map(([capability, entry]) => ({
		capability,
		modelCount: entry.models.size,
		providerCount: entry.providers.size,
		providers: Array.from(entry.providers).sort(),
		modes: Array.from(entry.modes).sort() as ModelMode[],
		exampleModelId: entry.exampleModelId,
	})).sort((a, b) => b.modelCount - a.modelCount || a.capability.localeCompare(b.capability));
}

/**
 * Pick the default pricing metric for a cheapest-model query.
 */
export function defaultPricingMetric(options?: CheapestModelOptions): PricingMetric {
	const effective = (options?.role ? normalizeRoleToken(options.role) : undefined) ?? (options?.capability ? normalizeRoleToken(options.capability) : undefined);
	if (options?.mode === "embedding" || effective === "embedding") return "input";
	if (options?.mode === "audio" && (effective === "speech_to_text" || effective === "text_to_speech")) return "input";
	return "blended";
}

/**
 * Compute a comparable score for a model/pricing metric combination.
 */
export function computeModelScore(model: ModelCard, metric: PricingMetric, inputWeight: number, outputWeight: number): number | undefined {
	if (!model.pricing) return undefined;
	if (metric === "input") return Number.isFinite(model.pricing.inputPerMillion) ? model.pricing.inputPerMillion : undefined;
	if (metric === "output") return Number.isFinite(model.pricing.outputPerMillion) ? model.pricing.outputPerMillion : undefined;
	return Number.isFinite(model.pricing.inputPerMillion) && Number.isFinite(model.pricing.outputPerMillion)
		? model.pricing.inputPerMillion * inputWeight + model.pricing.outputPerMillion * outputWeight
		: undefined;
}

/**
 * Normalize a user-supplied result limit into a safe positive integer.
 */
export function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return 5;
	return Math.max(1, Math.floor(limit));
}
