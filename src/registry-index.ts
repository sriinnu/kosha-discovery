/**
 * kosha-discovery — In-memory secondary indexes over RegistryState.providerMap.
 *
 * Replaces repeated O(N) scans in `registryModels`, `registryModelRoutes`,
 * and `ModelRegistry.model` with O(1) Map lookups while guaranteeing automatic
 * invalidation whenever any `ProviderInfo.models` array reference changes.
 * @module
 */

import { matchableModelId, normalizeModelId } from "./normalize.js";
import type { RegistryState } from "./registry-state.js";
import type { ModelCard } from "./types.js";

export interface RegistryIndex {
	readonly allModels: ModelCard[];
	readonly byExactId: Map<string, ModelCard[]>;
	readonly byMatchableLower: Map<string, ModelCard[]>;
	readonly byNormalizedLower: Map<string, ModelCard[]>;
	readonly byLooseKey: Map<string, ModelCard[]>;
	readonly byProvider: Map<string, { byId: Map<string, ModelCard>; models: ModelCard[] }>;
	readonly snapshotSignature: Array<[string, ModelCard[], number]>;
}

export function toLooseLookupKey(value: string): string {
	return value.replace(/[._-]+/g, "");
}

function pushGrouped(map: Map<string, ModelCard[]>, key: string, model: ModelCard): void {
	const existing = map.get(key);
	if (existing) existing.push(model);
	else map.set(key, [model]);
}

function isIndexFresh(index: RegistryIndex | null | undefined, state: RegistryState): index is RegistryIndex {
	if (!index) return false;
	if (index.snapshotSignature.length !== state.providerMap.size) return false;
	for (const [providerId, modelsRef, modelsLen] of index.snapshotSignature) {
		const current = state.providerMap.get(providerId);
		if (!current || current.models !== modelsRef || current.models.length !== modelsLen) return false;
	}
	return true;
}

export function buildRegistryIndex(state: RegistryState): RegistryIndex {
	const allModels: ModelCard[] = [];
	const byExactId = new Map<string, ModelCard[]>();
	const byMatchableLower = new Map<string, ModelCard[]>();
	const byNormalizedLower = new Map<string, ModelCard[]>();
	const byLooseKey = new Map<string, ModelCard[]>();
	const byProvider = new Map<string, { byId: Map<string, ModelCard>; models: ModelCard[] }>();
	const snapshotSignature: Array<[string, ModelCard[], number]> = [];
	const seen = new Set<string>();

	for (const providerInfo of state.providerMap.values()) {
		snapshotSignature.push([providerInfo.id, providerInfo.models, providerInfo.models.length]);
		const providerModelsById = new Map<string, ModelCard>();
		const providerDeduped: ModelCard[] = [];

		for (const model of providerInfo.models) {
			if (!providerModelsById.has(model.id)) providerModelsById.set(model.id, model);
			const dedupKey = `${model.provider}:${model.id}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);

			allModels.push(model);
			providerDeduped.push(model);
			pushGrouped(byExactId, model.id, model);
			pushGrouped(byMatchableLower, matchableModelId(model.id).toLowerCase(), model);
			const normalizedLower = normalizeModelId(model.id).toLowerCase();
			pushGrouped(byNormalizedLower, normalizedLower, model);
			pushGrouped(byLooseKey, toLooseLookupKey(normalizedLower), model);
		}

		byProvider.set(providerInfo.id, { byId: providerModelsById, models: providerDeduped });
	}

	return {
		allModels,
		byExactId,
		byMatchableLower,
		byNormalizedLower,
		byLooseKey,
		byProvider,
		snapshotSignature,
	};
}

export function getRegistryIndex(state: RegistryState): RegistryIndex {
	if (isIndexFresh(state.index, state)) return state.index;
	const index = buildRegistryIndex(state);
	state.index = index;
	return index;
}

export function invalidateRegistryIndex(state: RegistryState): void {
	state.index = null;
}
