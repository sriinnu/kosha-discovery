/**
 * kosha-discovery — Snapshot diff helpers for the discovery plane.
 *
 * I keep delta construction separate so the snapshot/health file stays small
 * and the diff semantics remain easy to test in isolation.
 * @module
 */

import { DISCOVERY_SCHEMA_VERSION } from "./discovery-contract.js";
import type {
	DiscoveryChangeV1,
	DiscoveryDeltaV1,
	DiscoverySnapshotV1,
} from "./discovery-contract.js";

/**
 * Expand a snapshot into full upsert changes for bootstrap consumers.
 */
export function fullSnapshotChanges(snapshot: DiscoverySnapshotV1): DiscoveryChangeV1[] {
	return [
		...snapshot.providers.map((provider): DiscoveryChangeV1 => ({
			entity: "provider",
			action: "upsert",
			key: provider.providerId,
			value: provider,
		})),
		...snapshot.models.map((model): DiscoveryChangeV1 => ({
			entity: "model",
			action: "upsert",
			key: model.key,
			value: model,
		})),
		...snapshot.health.map((health): DiscoveryChangeV1 => ({
			entity: "health",
			action: "upsert",
			key: health.providerId,
			value: health,
		})),
		...snapshot.credentialPrompts.map((prompt): DiscoveryChangeV1 => ({
			entity: "credential_prompt",
			action: "upsert",
			key: prompt.providerId,
			value: prompt,
		})),
	];
}

/**
 * Diff two snapshots into a single delta batch.
 */
export function diffSnapshots(
	previous: DiscoverySnapshotV1,
	next: DiscoverySnapshotV1,
): DiscoveryDeltaV1 {
	const changes: DiscoveryChangeV1[] = [];

	collectSectionChanges("provider", previous.providers, next.providers, (item) => item.providerId, changes);
	collectSectionChanges("model", previous.models, next.models, (item) => item.key, changes);
	collectSectionChanges("health", previous.health, next.health, (item) => item.providerId, changes);
	collectSectionChanges(
		"credential_prompt",
		previous.credentialPrompts,
		next.credentialPrompts,
		(item) => item.providerId,
		changes,
	);

	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		sinceCursor: previous.cursor,
		cursor: next.cursor,
		changedAt: next.discoveredAt,
		resetRequired: false,
		changes,
	};
}

function collectSectionChanges<T>(
	entity: DiscoveryChangeV1["entity"],
	previous: T[],
	next: T[],
	keyOf: (item: T) => string,
	target: DiscoveryChangeV1[],
): void {
	const previousMap = new Map(previous.map((item) => [keyOf(item), item]));
	const nextMap = new Map(next.map((item) => [keyOf(item), item]));

	for (const [key, item] of nextMap) {
		const prev = previousMap.get(key);
		// I use value-level JSON equality here because the schema objects are small and stable.
		if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) {
			target.push({ entity, action: "upsert", key, value: item as DiscoveryChangeV1["value"] });
		}
	}

	for (const key of previousMap.keys()) {
		if (!nextMap.has(key)) {
			target.push({ entity, action: "remove", key, value: null });
		}
	}
}
