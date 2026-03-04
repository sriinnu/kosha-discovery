/**
 * kosha-discovery — Resilience primitives.
 *
 * Provides a {@link CircuitBreaker} for per-provider fault isolation,
 * a {@link HealthTracker} that manages breakers for all known providers,
 * and a {@link StaleCachePolicy} that implements stale-while-revalidate
 * semantics on top of {@link KoshaCache}.
 *
 * The module is self-contained with no side-effects on import.
 * @module
 */

import type { KoshaCache } from "./cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Possible states of a {@link CircuitBreaker}. */
export type CircuitState = "closed" | "open" | "half-open";

/** Configuration options for a {@link CircuitBreaker} instance. */
export interface CircuitBreakerOptions {
	/**
	 * Number of consecutive failures before the circuit opens.
	 * @default 3
	 */
	failureThreshold?: number;
	/**
	 * Time (in milliseconds) the circuit stays open before transitioning
	 * to `half-open` to allow a probe request.
	 * @default 60_000
	 */
	resetTimeoutMs?: number;
	/**
	 * Number of consecutive successes in `half-open` state required to
	 * close the circuit again.
	 * @default 1
	 */
	halfOpenSuccessThreshold?: number;
}

/**
 * A point-in-time health snapshot for a single provider circuit.
 */
export interface ProviderHealth {
	/** Provider slug this health record belongs to. */
	providerId: string;
	/** Current circuit state. */
	state: CircuitState;
	/** Number of consecutive failures recorded since last reset. */
	failureCount: number;
	/** Unix timestamp (ms) of the most recent recorded failure, or 0. */
	lastFailureTime: number;
	/** Error message from the most recent failure, if available. */
	lastError?: string;
	/** Unix timestamp (ms) of the most recent recorded success, or 0. */
	lastSuccessTime: number;
}

/**
 * Wrapper returned by {@link StaleCachePolicy.getWithStale}.
 */
export interface StaleResult<T> {
	/** The cached payload. */
	data: T;
	/** True when the cache entry has exceeded its TTL. */
	stale: boolean;
	/** Milliseconds elapsed since the entry was written. */
	age: number;
	/** Unix timestamp (ms) when the entry was originally cached. */
	cachedAt: number;
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

/**
 * Per-provider circuit breaker with three states.
 *
 * - **closed** — Normal operation. All requests are allowed. Consecutive
 *   failures are counted; once the {@link CircuitBreakerOptions.failureThreshold}
 *   is reached the circuit transitions to `open`.
 * - **open** — Requests are rejected immediately (canExecute returns false).
 *   After {@link CircuitBreakerOptions.resetTimeoutMs} has elapsed the circuit
 *   transitions to `half-open` so a single probe request can be attempted.
 * - **half-open** — Exactly one request is let through. A success closes the
 *   circuit; a failure re-opens it and resets the timeout.
 *
 * @example
 * const cb = new CircuitBreaker("anthropic", { failureThreshold: 5 });
 * if (cb.canExecute()) {
 *   try {
 *     const result = await callApi();
 *     cb.onSuccess();
 *   } catch (err) {
 *     cb.onFailure(err.message);
 *   }
 * }
 */
export class CircuitBreaker {
	private state: CircuitState = "closed";
	private failureCount = 0;
	private successCount = 0;
	private lastFailureTime = 0;
	private lastSuccessTime = 0;
	private lastError?: string;

	/** Resolved threshold: consecutive failures before opening. */
	private readonly failureThreshold: number;
	/** Resolved open-state duration before allowing a probe. */
	private readonly resetTimeoutMs: number;
	/** Resolved success count in half-open needed to close. */
	private readonly halfOpenSuccessThreshold: number;

	constructor(readonly providerId: string, private options: CircuitBreakerOptions = {}) {
		this.failureThreshold = options.failureThreshold ?? 3;
		this.resetTimeoutMs = options.resetTimeoutMs ?? 60_000;
		this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 1;
	}

	/**
	 * Check whether a request should be allowed through.
	 *
	 * - `closed` → always true.
	 * - `open` → false, unless the reset timeout has elapsed, in which case
	 *   the circuit transitions to `half-open` and returns true for the probe.
	 * - `half-open` → true (the probe request is already in flight).
	 */
	canExecute(): boolean {
		if (this.state === "closed") {
			return true;
		}

		if (this.state === "open") {
			const elapsed = Date.now() - this.lastFailureTime;
			if (elapsed >= this.resetTimeoutMs) {
				// Transition to half-open: allow a single probe
				this.state = "half-open";
				this.successCount = 0;
				return true;
			}
			return false;
		}

		// half-open: allow the probe through
		return true;
	}

	/**
	 * Record a successful API call.
	 *
	 * In `half-open` state, once enough successes accumulate (per
	 * {@link CircuitBreakerOptions.halfOpenSuccessThreshold}) the circuit closes.
	 * In `closed` state the failure counter is reset.
	 */
	onSuccess(): void {
		this.lastSuccessTime = Date.now();

		if (this.state === "half-open") {
			this.successCount++;
			if (this.successCount >= this.halfOpenSuccessThreshold) {
				this.transitionToClosed();
			}
			return;
		}

		// In closed state reset the failure counter on any success
		if (this.state === "closed") {
			this.failureCount = 0;
		}
	}

	/**
	 * Record a failed API call.
	 *
	 * In `closed` state, increments the failure counter and opens the circuit
	 * when the threshold is reached. In `half-open` state, immediately
	 * re-opens the circuit.
	 *
	 * @param error - Optional error message to store for diagnostics.
	 */
	onFailure(error?: string): void {
		this.lastFailureTime = Date.now();
		this.lastError = error;

		if (this.state === "half-open") {
			// Probe failed — reopen immediately
			this.transitionToOpen();
			return;
		}

		if (this.state === "closed") {
			this.failureCount++;
			if (this.failureCount >= this.failureThreshold) {
				this.transitionToOpen();
			}
		}
	}

	/**
	 * Return a point-in-time health snapshot for this provider's circuit.
	 */
	health(): ProviderHealth {
		return {
			providerId: this.providerId,
			state: this.state,
			failureCount: this.failureCount,
			lastFailureTime: this.lastFailureTime,
			lastError: this.lastError,
			lastSuccessTime: this.lastSuccessTime,
		};
	}

	/**
	 * Force the circuit back to `closed` state, resetting all counters.
	 * Useful for manual recovery or test teardown.
	 */
	reset(): void {
		this.transitionToClosed();
		this.lastFailureTime = 0;
		this.lastSuccessTime = 0;
		this.lastError = undefined;
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private transitionToOpen(): void {
		this.state = "open";
		this.successCount = 0;
	}

	private transitionToClosed(): void {
		this.state = "closed";
		this.failureCount = 0;
		this.successCount = 0;
	}
}

// ---------------------------------------------------------------------------
// HealthTracker
// ---------------------------------------------------------------------------

/**
 * Manages {@link CircuitBreaker} instances for all tracked providers.
 *
 * Breakers are created lazily on first access via {@link breaker}.
 *
 * @example
 * const tracker = new HealthTracker();
 * const cb = tracker.breaker("anthropic");
 * if (cb.canExecute()) { ... }
 */
export class HealthTracker {
	private breakers = new Map<string, CircuitBreaker>();

	/**
	 * Retrieve the {@link CircuitBreaker} for the given provider, creating
	 * one with default options if it does not yet exist.
	 *
	 * @param providerId - Provider slug (e.g. `"anthropic"`).
	 * @param options    - Options forwarded to a newly created breaker only.
	 */
	breaker(providerId: string, options?: CircuitBreakerOptions): CircuitBreaker {
		let cb = this.breakers.get(providerId);
		if (!cb) {
			cb = new CircuitBreaker(providerId, options);
			this.breakers.set(providerId, cb);
		}
		return cb;
	}

	/**
	 * Return health snapshots for every tracked provider, sorted by provider ID.
	 */
	healthReport(): ProviderHealth[] {
		return Array.from(this.breakers.values())
			.map((cb) => cb.health())
			.sort((a, b) => a.providerId.localeCompare(b.providerId));
	}

	/**
	 * Return provider IDs whose circuit is `closed` or `half-open`
	 * (i.e. requests are currently being allowed through).
	 */
	availableProviders(): string[] {
		return Array.from(this.breakers.values())
			.filter((cb) => cb.canExecute())
			.map((cb) => cb.providerId)
			.sort();
	}

	/**
	 * Return provider IDs whose circuit is `open`
	 * (i.e. requests are currently being rejected).
	 */
	downProviders(): string[] {
		return Array.from(this.breakers.values())
			.filter((cb) => !cb.canExecute())
			.map((cb) => cb.providerId)
			.sort();
	}

	/**
	 * Reset all tracked circuit breakers to `closed` state.
	 */
	resetAll(): void {
		for (const cb of this.breakers.values()) {
			cb.reset();
		}
	}
}

// ---------------------------------------------------------------------------
// StaleCachePolicy
// ---------------------------------------------------------------------------

/**
 * Utility that wraps {@link KoshaCache} reads to implement
 * stale-while-revalidate semantics.
 *
 * Unlike the registry's normal cache path (which returns `null` for expired
 * entries), this policy always returns whatever was cached along with a
 * `stale` flag. This lets callers serve the old data immediately while
 * triggering a background refresh.
 *
 * Returns `null` only when the cache has never held a value for the key.
 *
 * @example
 * const result = await StaleCachePolicy.getWithStale<ModelCard[]>(cache, "provider_anthropic");
 * if (result) {
 *   serveToClient(result.data); // always fast
 *   if (result.stale) triggerBackgroundRefresh();
 * }
 */
export class StaleCachePolicy {
	/**
	 * Fetch a cached value regardless of its expiry, annotating the result
	 * with staleness metadata.
	 *
	 * @param cache - The {@link KoshaCache} instance to read from.
	 * @param key   - Cache key to look up.
	 * @returns A {@link StaleResult} when any cached value exists, or `null`
	 *          when the key has never been written.
	 */
	static async getWithStale<T>(cache: KoshaCache, key: string): Promise<StaleResult<T> | null> {
		// Use the raw get() which returns the entry regardless of TTL.
		// TTL checking is done separately so we can set the stale flag.
		const entry = await cache.get<T>(key);
		if (entry === null) {
			return null;
		}

		const now = Date.now();
		const age = now - entry.timestamp;

		// We need to determine staleness. KoshaCache.isExpired requires a TTL,
		// but StaleCachePolicy is TTL-agnostic — we expose the raw age and let
		// the caller decide. We set stale=true when age > 0 to signal that the
		// entry is not brand-new; callers that want TTL-based staleness should
		// compare age against their own threshold.
		//
		// A more useful signal: mark stale when the entry is older than the
		// default 24 h cache TTL used by the registry. Callers with custom TTLs
		// can compare age directly.
		const DEFAULT_TTL_MS = 86_400_000;
		const stale = age > DEFAULT_TTL_MS;

		return {
			data: entry.data,
			stale,
			age,
			cachedAt: entry.timestamp,
		};
	}
}
