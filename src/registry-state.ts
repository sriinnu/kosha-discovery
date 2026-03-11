/**
 * kosha-discovery — Internal registry state container.
 *
 * I keep mutable registry state in one plain object so helper modules can own
 * behavior without forcing `ModelRegistry` itself to grow into a god object.
 * @module
 */

import { EventEmitter } from "node:events";
import { AliasResolver } from "./aliases.js";
import { KoshaCache } from "./cache.js";
import type { DiscoveryDeltaV1, DiscoverySnapshotV1 } from "./discovery-contract.js";
import { HealthTracker } from "./resilience.js";
import type {
	CredentialResult,
	DiscoveryError,
	KoshaConfig,
	ProviderCredentialPrompt,
	ProviderDiscoverer,
	ProviderInfo,
} from "./types.js";

/**
 * Observation data used to build normalized provider-health summaries.
 */
export interface ProviderObservation {
	/** Rolling latency samples in milliseconds. */
	latenciesMs: number[];
	/** Count of timed-out attempts inside the rolling observation window. */
	timeoutCount: number;
	/** Number of observed attempts contributing to the health summary. */
	attemptCount: number;
	/** Last normalized error class seen for the provider, if any. */
	lastErrorType: "auth_error" | "throttled" | "timeout" | "transport" | "unknown" | null;
}

/**
 * All mutable state owned by a {@link ModelRegistry} instance.
 */
export interface RegistryState {
	/** Discovered providers keyed by canonical provider ID. */
	providerMap: Map<string, ProviderInfo>;
	/** Alias resolver shared by legacy and v1 surfaces. */
	aliasResolver: AliasResolver;
	/** Disk cache used for stale reads and snapshot reuse. */
	cache: KoshaCache;
	/** Effective merged registry configuration. */
	config: KoshaConfig;
	/** Timestamp of the last full discovery pass. */
	discoveredAt: number;
	/** Failures captured during the most recent discovery pass. */
	lastDiscoveryErrors: DiscoveryError[];
	/** Circuit-breaker health tracker. */
	healthTracker: HealthTracker;
	/** Rolling provider health observations. */
	providerObservations: Map<string, ProviderObservation>;
	/** Event bus used by watch-mode consumers. */
	discoveryEventBus: EventEmitter;
	/** Monotonic revision for discovery cursor generation. */
	discoveryRevision: number;
	/** Current discovery cursor. */
	currentCursor: string;
	/** Cached snapshot used for diff generation. */
	lastSnapshotCache: DiscoverySnapshotV1 | null;
	/** Recent deltas retained for polling consumers. */
	deltaHistory: DiscoveryDeltaV1[];
}

/**
 * Dependency bag used by discovery helpers.
 */
export interface DiscoveryDependencies {
	/** Resolve credentials for a provider on demand. */
	resolveCredential: ((providerId: string, explicitKey?: string) => Promise<CredentialResult>) | null;
	/** Load discoverers for the requested provider set. */
	loadDiscoverers: (providerIds?: string[], includeLocal?: boolean) => Promise<ProviderDiscoverer[]>;
	/** Enrich the in-memory provider map after discovery. */
	enrichModels: () => Promise<void>;
	/** Populate reverse aliases on discovered models. */
	populateModelAliases: () => void;
	/** Load fresh provider data from disk cache if available. */
	loadFromCache: (providerIds?: string[]) => Promise<boolean>;
	/** Persist current provider data to disk cache. */
	saveToCache: () => Promise<void>;
	/** Fallback credential resolution when the credential module is unavailable. */
	fallbackCredential: (providerId: string, explicitKey?: string) => CredentialResult;
	/** Build a snapshot from the current in-memory state. */
	snapshotForDelta: () => DiscoverySnapshotV1 | null;
	/** Record a successful mutation into the delta stream. */
	recordDiscoveryMutation: (previousSnapshot: DiscoverySnapshotV1 | null) => void;
	/** Store provider latency/error observations. */
	recordObservation: (providerId: string, entry: { latencyMs: number; errorType: ProviderObservation["lastErrorType"] }) => void;
	/** Normalize an error message into a provider observation class. */
	classifyError: (errorMessage: string) => ProviderObservation["lastErrorType"];
}

/**
 * Create the mutable state bag for a new registry instance.
 */
export function createRegistryState(config?: KoshaConfig): RegistryState {
	const discoveryEventBus = new EventEmitter();
	// I allow unlimited listeners because watch-mode consumers can fan out from one registry instance.
	discoveryEventBus.setMaxListeners(0);

	return {
		providerMap: new Map(),
		aliasResolver: new AliasResolver(config?.aliases),
		cache: new KoshaCache(config?.cacheDir),
		config: config ?? {},
		discoveredAt: 0,
		lastDiscoveryErrors: [],
		healthTracker: new HealthTracker(),
		providerObservations: new Map(),
		discoveryEventBus,
		discoveryRevision: 0,
		currentCursor: "",
		lastSnapshotCache: null,
		deltaHistory: [],
	};
}
