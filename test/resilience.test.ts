/**
 * Tests for the resilience module: CircuitBreaker, HealthTracker, StaleCachePolicy.
 */

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KoshaCache } from "../src/cache.js";
import {
	CircuitBreaker,
	HealthTracker,
	StaleCachePolicy,
	type CircuitState,
} from "../src/resilience.js";

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
	describe("initial state", () => {
		it("starts in closed state", () => {
			const cb = new CircuitBreaker("test-provider");
			expect(cb.health().state).toBe("closed");
		});

		it("allows requests when closed", () => {
			const cb = new CircuitBreaker("test-provider");
			expect(cb.canExecute()).toBe(true);
		});

		it("reports zero failure count initially", () => {
			const cb = new CircuitBreaker("test-provider");
			expect(cb.health().failureCount).toBe(0);
		});

		it("reports zero lastFailureTime initially", () => {
			const cb = new CircuitBreaker("test-provider");
			expect(cb.health().lastFailureTime).toBe(0);
		});

		it("reports zero lastSuccessTime initially", () => {
			const cb = new CircuitBreaker("test-provider");
			expect(cb.health().lastSuccessTime).toBe(0);
		});

		it("exposes the providerId passed to the constructor", () => {
			const cb = new CircuitBreaker("anthropic");
			expect(cb.providerId).toBe("anthropic");
			expect(cb.health().providerId).toBe("anthropic");
		});
	});

	// ---------------------------------------------------------------------------
	// Closed → Open transition
	// ---------------------------------------------------------------------------

	describe("closed state — failure accumulation", () => {
		it("increments failure count on each failure", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 5 });
			cb.onFailure("err1");
			expect(cb.health().failureCount).toBe(1);
			cb.onFailure("err2");
			expect(cb.health().failureCount).toBe(2);
		});

		it("stays closed below the threshold", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 3 });
			cb.onFailure();
			cb.onFailure();
			expect(cb.health().state).toBe("closed");
			expect(cb.canExecute()).toBe(true);
		});

		it("opens exactly at the failure threshold", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 3 });
			cb.onFailure();
			cb.onFailure();
			cb.onFailure(); // third failure — threshold reached
			expect(cb.health().state).toBe("open");
		});

		it("records the last error message", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 3 });
			cb.onFailure("first");
			cb.onFailure("second");
			expect(cb.health().lastError).toBe("second");
		});

		it("records lastFailureTime on each failure", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 5 });
			const before = Date.now();
			cb.onFailure("boom");
			const after = Date.now();
			expect(cb.health().lastFailureTime).toBeGreaterThanOrEqual(before);
			expect(cb.health().lastFailureTime).toBeLessThanOrEqual(after);
		});

		it("resets failure count on success in closed state", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 5 });
			cb.onFailure();
			cb.onFailure();
			cb.onSuccess();
			expect(cb.health().failureCount).toBe(0);
			expect(cb.health().state).toBe("closed");
		});

		it("records lastSuccessTime on success", () => {
			const cb = new CircuitBreaker("p");
			const before = Date.now();
			cb.onSuccess();
			const after = Date.now();
			expect(cb.health().lastSuccessTime).toBeGreaterThanOrEqual(before);
			expect(cb.health().lastSuccessTime).toBeLessThanOrEqual(after);
		});

		it("uses a default threshold of 3", () => {
			const cb = new CircuitBreaker("p"); // no options
			cb.onFailure();
			cb.onFailure();
			expect(cb.health().state).toBe("closed");
			cb.onFailure();
			expect(cb.health().state).toBe("open");
		});
	});

	// ---------------------------------------------------------------------------
	// Open state
	// ---------------------------------------------------------------------------

	describe("open state — rejecting requests", () => {
		it("rejects requests when open", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 1 });
			cb.onFailure();
			expect(cb.health().state).toBe("open");
			expect(cb.canExecute()).toBe(false);
		});

		it("continues rejecting within the reset timeout", () => {
			vi.useFakeTimers();
			const cb = new CircuitBreaker("p", { failureThreshold: 1, resetTimeoutMs: 60_000 });
			cb.onFailure();
			vi.advanceTimersByTime(59_999);
			expect(cb.canExecute()).toBe(false);
			vi.useRealTimers();
		});

		it("transitions to half-open after the reset timeout elapses", () => {
			vi.useFakeTimers();
			const cb = new CircuitBreaker("p", { failureThreshold: 1, resetTimeoutMs: 60_000 });
			cb.onFailure();
			expect(cb.health().state).toBe("open");

			vi.advanceTimersByTime(60_000);

			// canExecute triggers the transition
			const allowed = cb.canExecute();
			expect(allowed).toBe(true);
			expect(cb.health().state).toBe("half-open");
			vi.useRealTimers();
		});

		it("uses a default reset timeout of 60 000 ms", () => {
			vi.useFakeTimers();
			const cb = new CircuitBreaker("p", { failureThreshold: 1 });
			cb.onFailure();

			vi.advanceTimersByTime(59_999);
			expect(cb.canExecute()).toBe(false);

			vi.advanceTimersByTime(1);
			expect(cb.canExecute()).toBe(true); // now half-open
			vi.useRealTimers();
		});
	});

	// ---------------------------------------------------------------------------
	// Half-open state
	// ---------------------------------------------------------------------------

	describe("half-open state", () => {
		function openThenExpire(threshold = 1, resetTimeoutMs = 60_000): CircuitBreaker {
			vi.useFakeTimers();
			const cb = new CircuitBreaker("p", { failureThreshold: threshold, resetTimeoutMs });
			for (let i = 0; i < threshold; i++) cb.onFailure("err");
			vi.advanceTimersByTime(resetTimeoutMs);
			cb.canExecute(); // triggers transition to half-open
			return cb;
		}

		it("allows requests in half-open state", () => {
			const cb = openThenExpire();
			expect(cb.health().state).toBe("half-open");
			expect(cb.canExecute()).toBe(true);
			vi.useRealTimers();
		});

		it("closes the circuit on success in half-open (default threshold = 1)", () => {
			const cb = openThenExpire();
			cb.onSuccess();
			expect(cb.health().state).toBe("closed");
			expect(cb.health().failureCount).toBe(0);
			vi.useRealTimers();
		});

		it("requires halfOpenSuccessThreshold successes before closing", () => {
			vi.useFakeTimers();
			const cb = new CircuitBreaker("p", {
				failureThreshold: 1,
				resetTimeoutMs: 1_000,
				halfOpenSuccessThreshold: 3,
			});
			cb.onFailure();
			vi.advanceTimersByTime(1_000);
			cb.canExecute(); // → half-open

			cb.onSuccess();
			expect(cb.health().state).toBe("half-open"); // 1 of 3

			cb.onSuccess();
			expect(cb.health().state).toBe("half-open"); // 2 of 3

			cb.onSuccess();
			expect(cb.health().state).toBe("closed"); // 3 of 3 ✓
			vi.useRealTimers();
		});

		it("reopens the circuit on failure in half-open", () => {
			const cb = openThenExpire();
			cb.onFailure("probe failed");
			expect(cb.health().state).toBe("open");
			vi.useRealTimers();
		});

		it("rejects requests again after reopening from half-open", () => {
			vi.useFakeTimers();
			const cb = openThenExpire();
			cb.onFailure(); // probe fails → back to open
			vi.advanceTimersByTime(30_000); // within reset timeout
			expect(cb.canExecute()).toBe(false);
			vi.useRealTimers();
		});

		it("can cycle: open → half-open → open → half-open → closed", () => {
			vi.useFakeTimers();
			const cb = new CircuitBreaker("p", { failureThreshold: 1, resetTimeoutMs: 1_000 });

			// First cycle: probe fails
			cb.onFailure();
			vi.advanceTimersByTime(1_000);
			cb.canExecute(); // → half-open
			cb.onFailure(); // → open again

			expect(cb.health().state).toBe("open");

			// Second cycle: probe succeeds
			vi.advanceTimersByTime(1_000);
			cb.canExecute(); // → half-open
			cb.onSuccess(); // → closed

			expect(cb.health().state).toBe("closed");
			vi.useRealTimers();
		});
	});

	// ---------------------------------------------------------------------------
	// Reset
	// ---------------------------------------------------------------------------

	describe("reset()", () => {
		it("returns an open circuit to closed", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 1 });
			cb.onFailure();
			expect(cb.health().state).toBe("open");
			cb.reset();
			expect(cb.health().state).toBe("closed");
		});

		it("clears the failure count", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 5 });
			cb.onFailure();
			cb.onFailure();
			cb.reset();
			expect(cb.health().failureCount).toBe(0);
		});

		it("clears lastFailureTime and lastSuccessTime", () => {
			const cb = new CircuitBreaker("p");
			cb.onFailure("err");
			cb.onSuccess();
			cb.reset();
			expect(cb.health().lastFailureTime).toBe(0);
			expect(cb.health().lastSuccessTime).toBe(0);
		});

		it("clears the last error message", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 1 });
			cb.onFailure("something broke");
			cb.reset();
			expect(cb.health().lastError).toBeUndefined();
		});

		it("allows requests again immediately after reset", () => {
			const cb = new CircuitBreaker("p", { failureThreshold: 1 });
			cb.onFailure();
			cb.reset();
			expect(cb.canExecute()).toBe(true);
		});

		it("is idempotent on a closed circuit", () => {
			const cb = new CircuitBreaker("p");
			cb.reset();
			cb.reset();
			expect(cb.health().state).toBe("closed");
			expect(cb.health().failureCount).toBe(0);
		});
	});

	// ---------------------------------------------------------------------------
	// health() snapshot
	// ---------------------------------------------------------------------------

	describe("health() snapshot", () => {
		it("returns a plain object (not a reference to internal state)", () => {
			const cb = new CircuitBreaker("p");
			const h1 = cb.health();
			cb.onFailure("err");
			const h2 = cb.health();
			// h1 should still report 0 failures
			expect(h1.failureCount).toBe(0);
			expect(h2.failureCount).toBe(1);
		});

		it("includes all required ProviderHealth fields", () => {
			const cb = new CircuitBreaker("openai");
			const h = cb.health();
			expect(h).toHaveProperty("providerId", "openai");
			expect(h).toHaveProperty("state");
			expect(h).toHaveProperty("failureCount");
			expect(h).toHaveProperty("lastFailureTime");
			expect(h).toHaveProperty("lastSuccessTime");
		});
	});
});

// ---------------------------------------------------------------------------
// HealthTracker
// ---------------------------------------------------------------------------

describe("HealthTracker", () => {
	it("returns a CircuitBreaker for a new provider", () => {
		const tracker = new HealthTracker();
		const cb = tracker.breaker("anthropic");
		expect(cb).toBeInstanceOf(CircuitBreaker);
		expect(cb.providerId).toBe("anthropic");
	});

	it("returns the same instance for repeated calls with the same provider", () => {
		const tracker = new HealthTracker();
		const cb1 = tracker.breaker("openai");
		const cb2 = tracker.breaker("openai");
		expect(cb1).toBe(cb2);
	});

	it("manages independent breakers for different providers", () => {
		const tracker = new HealthTracker();
		const anthropic = tracker.breaker("anthropic", { failureThreshold: 1 });
		const openai = tracker.breaker("openai", { failureThreshold: 1 });

		anthropic.onFailure(); // trips anthropic
		expect(anthropic.health().state).toBe("open");
		expect(openai.health().state).toBe("closed"); // openai unaffected
	});

	describe("healthReport()", () => {
		it("returns an empty array when no breakers exist", () => {
			const tracker = new HealthTracker();
			expect(tracker.healthReport()).toEqual([]);
		});

		it("returns health for all tracked providers", () => {
			const tracker = new HealthTracker();
			tracker.breaker("b-provider");
			tracker.breaker("a-provider");
			const report = tracker.healthReport();
			expect(report).toHaveLength(2);
		});

		it("sorts results by providerId", () => {
			const tracker = new HealthTracker();
			tracker.breaker("zeta");
			tracker.breaker("alpha");
			tracker.breaker("mu");
			const ids = tracker.healthReport().map((h) => h.providerId);
			expect(ids).toEqual(["alpha", "mu", "zeta"]);
		});
	});

	describe("availableProviders()", () => {
		it("returns all providers when all are closed", () => {
			const tracker = new HealthTracker();
			tracker.breaker("a");
			tracker.breaker("b");
			const available = tracker.availableProviders();
			expect(available.sort()).toEqual(["a", "b"]);
		});

		it("excludes providers whose circuit is open", () => {
			const tracker = new HealthTracker();
			tracker.breaker("good");
			const bad = tracker.breaker("bad", { failureThreshold: 1 });
			bad.onFailure();
			expect(tracker.availableProviders()).toEqual(["good"]);
		});

		it("includes half-open providers (they allow a probe)", () => {
			vi.useFakeTimers();
			const tracker = new HealthTracker();
			const cb = tracker.breaker("probe-me", { failureThreshold: 1, resetTimeoutMs: 1_000 });
			cb.onFailure();
			vi.advanceTimersByTime(1_000);
			// Trigger the open → half-open transition via canExecute
			cb.canExecute();
			expect(cb.health().state).toBe("half-open");
			expect(tracker.availableProviders()).toContain("probe-me");
			vi.useRealTimers();
		});
	});

	describe("downProviders()", () => {
		it("returns empty when all providers are healthy", () => {
			const tracker = new HealthTracker();
			tracker.breaker("a");
			tracker.breaker("b");
			expect(tracker.downProviders()).toEqual([]);
		});

		it("returns providers whose circuit is open", () => {
			const tracker = new HealthTracker();
			tracker.breaker("healthy");
			const sick = tracker.breaker("sick", { failureThreshold: 1 });
			sick.onFailure();
			expect(tracker.downProviders()).toEqual(["sick"]);
		});

		it("does not include half-open providers", () => {
			vi.useFakeTimers();
			const tracker = new HealthTracker();
			const cb = tracker.breaker("recovering", { failureThreshold: 1, resetTimeoutMs: 1_000 });
			cb.onFailure();
			vi.advanceTimersByTime(1_000);
			cb.canExecute(); // → half-open
			expect(tracker.downProviders()).not.toContain("recovering");
			vi.useRealTimers();
		});
	});

	describe("resetAll()", () => {
		it("resets every tracked breaker to closed", () => {
			const tracker = new HealthTracker();
			const a = tracker.breaker("a", { failureThreshold: 1 });
			const b = tracker.breaker("b", { failureThreshold: 1 });
			a.onFailure();
			b.onFailure();
			expect(a.health().state).toBe("open");
			expect(b.health().state).toBe("open");

			tracker.resetAll();

			expect(a.health().state).toBe("closed");
			expect(b.health().state).toBe("closed");
		});

		it("is a no-op when no breakers exist", () => {
			const tracker = new HealthTracker();
			expect(() => tracker.resetAll()).not.toThrow();
		});

		it("allows requests from all providers after reset", () => {
			const tracker = new HealthTracker();
			const cb = tracker.breaker("p", { failureThreshold: 1 });
			cb.onFailure();
			tracker.resetAll();
			expect(tracker.availableProviders()).toContain("p");
			expect(tracker.downProviders()).toHaveLength(0);
		});
	});
});

// ---------------------------------------------------------------------------
// StaleCachePolicy
// ---------------------------------------------------------------------------

describe("StaleCachePolicy", () => {
	let tempDir: string;
	let cache: KoshaCache;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "kosha-resilience-test-"));
		cache = new KoshaCache(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("returns null when the key has never been cached", async () => {
		const result = await StaleCachePolicy.getWithStale(cache, "never-set");
		expect(result).toBeNull();
	});

	it("returns the cached data when the key exists", async () => {
		const payload = { models: ["gpt-4o", "claude-opus-4-6"] };
		await cache.set("provider_test", payload);
		const result = await StaleCachePolicy.getWithStale<typeof payload>(cache, "provider_test");
		expect(result).not.toBeNull();
		expect(result!.data).toEqual(payload);
	});

	it("returns a fresh entry as not stale (age < 24 h default TTL)", async () => {
		await cache.set("fresh-key", "value");
		const result = await StaleCachePolicy.getWithStale<string>(cache, "fresh-key");
		expect(result).not.toBeNull();
		expect(result!.stale).toBe(false);
	});

	it("marks an old entry as stale (age > 24 h default TTL)", async () => {
		// Write an entry then pretend it was written >24 h ago by patching Date.now
		await cache.set("old-key", "ancient");

		// Advance time by more than 24 hours
		const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000;
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + TWENTY_FIVE_HOURS_MS);

		const result = await StaleCachePolicy.getWithStale<string>(cache, "old-key");
		expect(result).not.toBeNull();
		expect(result!.stale).toBe(true);

		vi.restoreAllMocks();
	});

	it("sets the cachedAt field to the original write timestamp", async () => {
		const before = Date.now();
		await cache.set("ts-key", 42);
		const after = Date.now();

		const result = await StaleCachePolicy.getWithStale<number>(cache, "ts-key");
		expect(result).not.toBeNull();
		expect(result!.cachedAt).toBeGreaterThanOrEqual(before);
		expect(result!.cachedAt).toBeLessThanOrEqual(after);
	});

	it("sets the age field to ms elapsed since the write", async () => {
		await cache.set("age-key", "data");

		// Advance time by 5 seconds
		const FIVE_SECONDS_MS = 5_000;
		const originalNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(originalNow + FIVE_SECONDS_MS);

		const result = await StaleCachePolicy.getWithStale<string>(cache, "age-key");
		expect(result).not.toBeNull();
		// Age should be approximately FIVE_SECONDS_MS
		expect(result!.age).toBeGreaterThanOrEqual(FIVE_SECONDS_MS - 10);
		expect(result!.age).toBeLessThanOrEqual(FIVE_SECONDS_MS + 500);

		vi.restoreAllMocks();
	});

	it("returns data even when the cache entry is expired (stale-while-revalidate)", async () => {
		const staleData = { count: 99 };
		await cache.set("stale-key", staleData);

		// Advance well past the default 24 h TTL
		const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + TWO_DAYS_MS);

		const result = await StaleCachePolicy.getWithStale<typeof staleData>(cache, "stale-key");
		// Should still have data, not null
		expect(result).not.toBeNull();
		expect(result!.data).toEqual(staleData);
		expect(result!.stale).toBe(true);

		vi.restoreAllMocks();
	});

	it("works with complex nested object payloads", async () => {
		const complex = {
			id: "openai",
			models: [{ id: "gpt-4o", mode: "chat" as const }],
			lastRefreshed: Date.now(),
		};
		await cache.set("complex-key", complex);
		const result = await StaleCachePolicy.getWithStale<typeof complex>(cache, "complex-key");
		expect(result).not.toBeNull();
		expect(result!.data).toEqual(complex);
	});
});
