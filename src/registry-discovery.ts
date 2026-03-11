/**
 * kosha-discovery — Discovery snapshot, delta, and health helpers.
 *
 * I keep the versioned discovery-plane projection here so `ModelRegistry`
 * itself can stay focused on API shape and orchestration.
 * @module
 */

import {
	DISCOVERY_SCHEMA_VERSION,
	discoveryRoles,
	makeModelKey,
	rawCapabilitiesForModel,
	trustedCapabilitiesForModel,
} from "./discovery-contract.js";
import type {
	DiscoveryDeltaV1,
	DiscoveryHealthRecord,
	DiscoveryModelV1,
	DiscoveryProviderV1,
	DiscoverySnapshotV1,
} from "./discovery-contract.js";
import { getProviderConfig, listProviderDescriptors, normalizeProviderId } from "./provider-catalog.js";
import { diffSnapshots, fullSnapshotChanges } from "./registry-delta.js";
import { registryModels, registryProviderDescriptor } from "./registry-query.js";
import type { ModelCard, ProviderCredentialPrompt } from "./types.js";
import type { ProviderObservation, RegistryState } from "./registry-state.js";

/**
 * Return the cached snapshot when it is still valid for diff generation.
 */
export function registrySnapshotForDelta(state: RegistryState): DiscoverySnapshotV1 | null {
	if (state.lastSnapshotCache) return state.lastSnapshotCache;
	if (state.providerMap.size === 0 && state.discoveredAt === 0) return null;
	return registryBuildSnapshot(state, state.currentCursor);
}

/**
 * Build and cache the stable v1 discovery snapshot.
 */
export function registryDiscoverySnapshot(state: RegistryState): DiscoverySnapshotV1 {
	const snapshot = registryBuildSnapshot(state, state.currentCursor);
	state.lastSnapshotCache = snapshot;
	return snapshot;
}

/**
 * Return discovery deltas since a previous cursor.
 */
export function registryDiscoveryDelta(
	state: RegistryState,
	options?: { sinceCursor?: string | null },
): DiscoveryDeltaV1 {
	const snapshot = registryDiscoverySnapshot(state);
	const sinceCursor = options?.sinceCursor ?? null;

	if (!sinceCursor) {
		return {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			sinceCursor,
			cursor: snapshot.cursor,
			changedAt: snapshot.discoveredAt,
			resetRequired: false,
			changes: fullSnapshotChanges(snapshot),
		};
	}

	if (sinceCursor === snapshot.cursor) {
		return {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			sinceCursor,
			cursor: snapshot.cursor,
			changedAt: snapshot.discoveredAt,
			resetRequired: false,
			changes: [],
		};
	}

	const sinceIndex = state.deltaHistory.findIndex((delta) =>
		delta.sinceCursor === sinceCursor || delta.cursor === sinceCursor
	);
	if (sinceIndex === -1) {
		return {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			sinceCursor,
			cursor: snapshot.cursor,
			changedAt: snapshot.discoveredAt,
			resetRequired: true,
			changes: [],
		};
	}

	const deltas = state.deltaHistory.slice(sinceIndex);
	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		sinceCursor,
		cursor: snapshot.cursor,
		changedAt: deltas.at(-1)?.changedAt ?? snapshot.discoveredAt,
		resetRequired: false,
		changes: deltas.flatMap((delta) => delta.changes),
	};
}

/**
 * Stream live deltas through the shared registry event bus.
 */
export async function* registryWatchDiscovery(
	state: RegistryState,
	options?: { sinceCursor?: string | null },
): AsyncGenerator<DiscoveryDeltaV1, void, void> {
	const backlog = registryDiscoveryDelta(state, { sinceCursor: options?.sinceCursor ?? null });
	if (backlog.resetRequired || backlog.changes.length > 0) {
		// I replay backlog first so watch clients can bootstrap and then switch to live deltas.
		yield backlog;
	}

	const queue: DiscoveryDeltaV1[] = [];
	let notify: (() => void) | undefined;
	const listener = (delta: DiscoveryDeltaV1) => {
		queue.push(delta);
		notify?.();
		notify = undefined;
	};

	state.discoveryEventBus.on("delta", listener);
	try {
		while (true) {
			if (queue.length === 0) {
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
			const next = queue.shift();
			if (next) yield next;
		}
	} finally {
		state.discoveryEventBus.off("delta", listener);
	}
}

/**
 * Advance the discovery cursor and emit a delta when the snapshot changes.
 */
export function registryRecordDiscoveryMutation(
	state: RegistryState,
	previousSnapshot: DiscoverySnapshotV1 | null,
): void {
	state.discoveryRevision += 1;
	state.currentCursor = registryMakeCursor(state);
	const nextSnapshot = registryBuildSnapshot(state, state.currentCursor);
	state.lastSnapshotCache = nextSnapshot;

	if (!previousSnapshot) {
		return;
	}

	const delta = diffSnapshots(previousSnapshot, nextSnapshot);
	if (delta.changes.length === 0) {
		return;
	}

	state.deltaHistory.push(delta);
	if (state.deltaHistory.length > 50) {
		state.deltaHistory.shift();
	}
	state.discoveryEventBus.emit("delta", delta);
}

/**
 * Build a monotonic cursor for snapshot and delta consumers.
 */
export function registryMakeCursor(state: RegistryState): string {
	return `discovery-${state.discoveryRevision}-${state.discoveredAt || Date.now()}`;
}

/**
 * Build the stable v1 discovery snapshot from in-memory state.
 */
export function registryBuildSnapshot(state: RegistryState, cursor: string): DiscoverySnapshotV1 {
	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		discoveredAt: state.discoveredAt || null,
		cursor,
		providers: listProviderDescriptors()
			.map((descriptor) => registrySerializeProvider(state, descriptor.providerId))
			.sort((a, b) => a.providerId.localeCompare(b.providerId)),
		models: registryModels(state)
			.map((model) => registrySerializeModel(state, model))
			.sort((a, b) => a.key.localeCompare(b.key)),
		roles: discoveryRoles(),
		health: listProviderDescriptors()
			.map((descriptor) => registryBuildHealthRecord(state, descriptor.providerId))
			.sort((a, b) => a.providerId.localeCompare(b.providerId)),
		credentialPrompts: catalogCredentialPrompts(state).map((prompt) => ({
			providerId: prompt.providerId,
			providerName: prompt.providerName,
			required: prompt.required,
			envVars: [...prompt.envVars],
			message: prompt.message,
		})),
	};
}

/**
 * Serialize one provider entry into the stable v1 schema.
 */
export function registrySerializeProvider(state: RegistryState, providerId: string): DiscoveryProviderV1 {
	const provider = state.providerMap.get(providerId);
	const descriptor = registryProviderDescriptor(state, providerId, provider);
	const config = getProviderConfig(state.config, providerId);

	return {
		providerId: descriptor.providerId,
		canonicalProviderId: descriptor.canonicalProviderId,
		aliases: [...descriptor.aliases],
		name: descriptor.name,
		origin: descriptor.origin,
		isLocal: descriptor.isLocal,
		transport: descriptor.transport,
		authenticated: provider?.authenticated ?? false,
		credentialSource: provider?.credentialSource ?? null,
		credentialsPresent: provider?.authenticated ?? false,
		credentialsRequired: descriptor.credentialRequired,
		credentialEnvVars: [...descriptor.credentialEnvVars],
		modelCount: provider?.models.length ?? 0,
		lastRefreshed: provider?.lastRefreshed ?? null,
		baseUrl: provider?.baseUrl ?? config?.baseUrl ?? descriptor.defaultBaseUrl,
	};
}

/**
 * Serialize one model route into the stable v1 schema.
 */
export function registrySerializeModel(state: RegistryState, model: ModelCard): DiscoveryModelV1 {
	const descriptor = registryProviderDescriptor(state, model.provider, state.providerMap.get(model.provider));
	const runtime = model.localRuntime;

	return {
		key: makeModelKey(model, descriptor),
		modelId: model.id,
		name: model.name,
		providerId: model.provider,
		canonicalProviderId: descriptor.canonicalProviderId,
		originProviderId: normalizeProviderId(model.originProvider) ?? model.originProvider ?? descriptor.canonicalProviderId,
		mode: model.mode,
		capabilities: trustedCapabilitiesForModel(model, descriptor),
		rawCapabilities: rawCapabilitiesForModel(model),
		contextWindow: model.contextWindow > 0 ? model.contextWindow : null,
		maxOutputTokens: model.maxOutputTokens > 0 ? model.maxOutputTokens : null,
		pricing: model.pricing ?? null,
		dimensions: model.dimensions ?? null,
		maxInputTokens: model.maxInputTokens ?? null,
		discoveredAt: model.discoveredAt,
		source: model.source,
		aliases: [...model.aliases],
		region: model.region ?? null,
		projectId: model.projectId ?? null,
		runtimeFamily: runtime?.runtimeFamily ?? (descriptor.isLocal ? descriptor.canonicalProviderId : null),
		tokenizerFamily: runtime?.tokenizerFamily ?? null,
		quantization: runtime?.quantization ?? null,
		memoryFootprintBytes: runtime?.memoryFootprintBytes ?? null,
		computeTarget: runtime?.computeTarget ?? null,
		supportsStructuredOutput: runtime?.supportsStructuredOutput ?? null,
		supportsStreaming: runtime?.supportsStreaming ?? null,
	};
}

/**
 * Build the normalized provider-health projection for the v1 schema.
 */
export function registryBuildHealthRecord(state: RegistryState, providerId: string): DiscoveryHealthRecord {
	const breaker = state.healthTracker.breaker(providerId).health();
	const observation = state.providerObservations.get(providerId);
	const provider = state.providerMap.get(providerId);
	const timeoutRate = observation && observation.attemptCount > 0
		? observation.timeoutCount / observation.attemptCount
		: 0;
	const latencyClass = computeLatencyClass(observation);
	let stateLabel: DiscoveryHealthRecord["state"] = "unknown";

	// I keep auth and throttle failures distinct because they imply different downstream actions.
	if (observation?.lastErrorType === "auth_error") {
		stateLabel = "auth_error";
	} else if (observation?.lastErrorType === "throttled") {
		stateLabel = "throttled";
	} else if (breaker.state === "open" && observation?.attemptCount) {
		stateLabel = "down";
	} else if (provider?.lastRefreshed && (breaker.failureCount > 0 || timeoutRate >= 0.25 || latencyClass === "high")) {
		stateLabel = "degraded";
	} else if (breaker.lastSuccessTime > 0 || provider?.lastRefreshed) {
		stateLabel = "healthy";
	}

	return {
		providerId,
		state: stateLabel,
		failureCount: breaker.failureCount,
		lastError: breaker.lastError ?? null,
		lastSuccessAt: breaker.lastSuccessTime || provider?.lastRefreshed || null,
		lastFailureAt: breaker.lastFailureTime || null,
		latencyClass,
		timeoutRate: Number(timeoutRate.toFixed(3)),
		rateLimitState: observation?.lastErrorType === "throttled" ? "throttled" : observation?.attemptCount ? "ok" : "unknown",
		circuitState: breaker.state,
	};
}

/**
 * Store one provider observation for later health normalization.
 */
export function registryRecordObservation(
	state: RegistryState,
	providerId: string,
	entry: { latencyMs: number; errorType: ProviderObservation["lastErrorType"] },
): void {
	const observation = state.providerObservations.get(providerId) ?? {
		latenciesMs: [],
		timeoutCount: 0,
		attemptCount: 0,
		lastErrorType: null,
	};

	observation.attemptCount += 1;
	observation.latenciesMs.push(entry.latencyMs);
	if (observation.latenciesMs.length > 20) {
		observation.latenciesMs.shift();
	}
	if (entry.errorType === "timeout") {
		observation.timeoutCount += 1;
	}
	observation.lastErrorType = entry.errorType;
	state.providerObservations.set(providerId, observation);
}

/**
 * Normalize a provider error message into a stable health class.
 */
export function registryClassifyError(errorMessage: string): ProviderObservation["lastErrorType"] {
	const lower = errorMessage.toLowerCase();
	if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
		return "auth_error";
	}
	if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
		return "throttled";
	}
	if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("abort")) {
		return "timeout";
	}
	if (lower.includes("network") || lower.includes("econn") || lower.includes("fetch failed") || lower.includes("5")) {
		return "transport";
	}
	return "unknown";
}

function catalogCredentialPrompts(state: RegistryState): ProviderCredentialPrompt[] {
	const prompts: ProviderCredentialPrompt[] = [];

	for (const descriptor of listProviderDescriptors()) {
		const provider = state.providerMap.get(descriptor.providerId);
		if (!descriptor.credentialRequired || provider?.authenticated) {
			continue;
		}

		const envHint = descriptor.credentialEnvVars.length > 0
			? `Set ${descriptor.credentialEnvVars.join(" or ")}`
			: "Configure credentials";

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

function computeLatencyClass(
	observation: ProviderObservation | undefined,
): DiscoveryHealthRecord["latencyClass"] {
	if (!observation || observation.attemptCount === 0 || observation.latenciesMs.length === 0) {
		return "unknown";
	}
	if (observation.lastErrorType === "timeout") {
		return "timeout";
	}

	const average = observation.latenciesMs.reduce((sum, value) => sum + value, 0) / observation.latenciesMs.length;
	if (average <= 1_000) return "low";
	if (average <= 4_000) return "medium";
	return "high";
}
