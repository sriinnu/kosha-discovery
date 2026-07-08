/**
 * Tests for the health-aware route ranking engine.
 *
 * Drives RegistryState directly (observations + breakers are internal) so we
 * can assert how each strategy folds runtime signal into the ordering.
 */

import { describe, expect, it } from "vitest";
import { createRegistryState } from "../src/registry-state.js";
import { providerRouteHealth, rankCandidatesByStrategy } from "../src/registry-routing.js";
import type { CheapestModelMatch, ModelCard } from "../src/types.js";

function model(id: string, provider: string): ModelCard {
	return {
		id,
		name: id,
		provider,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: 0,
		source: "manual",
	};
}

function match(id: string, provider: string, score: number | undefined): CheapestModelMatch {
	return { model: model(id, provider), score, priceMetric: "blended" };
}

/** Same as match() but lets the caller pin a lifecycle status on the model. */
function matchWithStatus(id: string, provider: string, score: number | undefined, status: ModelCard["status"]): CheapestModelMatch {
	const card = model(id, provider);
	card.status = status;
	return { model: card, score, priceMetric: "blended" };
}

/** Build a state and seed each provider's observation window. */
function seed(observations: Record<string, { latencies: number[]; timeouts?: number; attempts?: number; lastError?: "auth_error" | "throttled" | "timeout" | "transport" | "unknown" }>) {
	const state = createRegistryState();
	for (const [providerId, o] of Object.entries(observations)) {
		state.providerObservations.set(providerId, {
			latenciesMs: o.latencies,
			timeoutCount: o.timeouts ?? 0,
			attemptCount: o.attempts ?? o.latencies.length,
			lastErrorType: o.lastError ?? null,
		});
	}
	return state;
}

describe("providerRouteHealth", () => {
	it("computes p95, mean, timeout rate, and reliability from observations", () => {
		const state = seed({ groq: { latencies: [100, 120, 110, 130, 90], timeouts: 0, attempts: 5 } });
		const h = providerRouteHealth(state, "groq");
		expect(h.samples).toBe(5);
		expect(h.p95LatencyMs).toBe(130);
		expect(h.avgLatencyMs).toBe(110);
		expect(h.timeoutRate).toBe(0);
		expect(h.reliabilityScore).toBe(1);
		expect(h.available).toBe(true);
		expect(h.breakerState).toBe("closed");
	});

	it("drops reliability and availability when the breaker is open", () => {
		const state = seed({ flaky: { latencies: [200], attempts: 1 } });
		const breaker = state.healthTracker.breaker("flaky");
		breaker.onFailure("boom");
		breaker.onFailure("boom");
		breaker.onFailure("boom"); // default threshold = 3 -> open
		const h = providerRouteHealth(state, "flaky");
		expect(h.breakerState).toBe("open");
		expect(h.available).toBe(false);
		expect(h.reliabilityScore).toBe(0);
	});

	it("penalizes timeouts and auth errors", () => {
		const state = seed({ t: { latencies: [500], timeouts: 1, attempts: 4 }, a: { latencies: [500], lastError: "auth_error", attempts: 1 } });
		expect(providerRouteHealth(state, "t").reliabilityScore).toBeCloseTo(0.75, 3);
		expect(providerRouteHealth(state, "a").reliabilityScore).toBeCloseTo(0.1, 3);
	});

	it("treats an unobserved provider as optimistically reliable but latency-unknown", () => {
		const state = createRegistryState();
		const h = providerRouteHealth(state, "never-seen");
		expect(h.samples).toBe(0);
		expect(h.p95LatencyMs).toBeNull();
		expect(h.reliabilityScore).toBe(1);
		expect(h.available).toBe(true);
	});
});

describe("rankCandidatesByStrategy", () => {
	// fast: quick + clean. cheap: cheapest, no telemetry. slow: high latency.
	// down: cheapest of all, but breaker open (should never win).
	const matches = [
		match("m-down", "down", 0.5),
		match("m-cheap", "cheap", 1),
		match("m-slow", "slow", 2),
		match("m-fast", "fast", 5),
	];

	function stateWithHealth() {
		const state = seed({
			fast: { latencies: [100, 110, 120], attempts: 3 },
			slow: { latencies: [3000, 3200, 3100], attempts: 3 },
			down: { latencies: [50], attempts: 1 },
			// cheap has no observations
		});
		const b = state.healthTracker.breaker("down");
		b.onFailure("x");
		b.onFailure("x");
		b.onFailure("x");
		return state;
	}

	it("cheapest preserves price order but pushes the open-breaker provider last", () => {
		const ranked = rankCandidatesByStrategy(stateWithHealth(), matches, "cheapest");
		expect(ranked.map((r) => r.providerId)).toEqual(["cheap", "slow", "fast", "down"]);
	});

	it("fastest puts the lowest-latency provider first", () => {
		const ranked = rankCandidatesByStrategy(stateWithHealth(), matches, "fastest");
		expect(ranked[0].providerId).toBe("fast");
		// cheap has no telemetry -> ranks behind measured providers but ahead of down
		expect(ranked.map((r) => r.providerId)).toEqual(["fast", "slow", "cheap", "down"]);
	});

	it("reliable ranks the open-breaker provider last and clean providers ahead", () => {
		const ranked = rankCandidatesByStrategy(stateWithHealth(), matches, "reliable");
		expect(ranked.at(-1)?.providerId).toBe("down");
		expect(ranked[0].health.reliabilityScore).toBe(1);
	});

	it("balanced returns every candidate deterministically with the open one last", () => {
		const a = rankCandidatesByStrategy(stateWithHealth(), matches, "balanced").map((r) => r.providerId);
		const b = rankCandidatesByStrategy(stateWithHealth(), matches, "balanced").map((r) => r.providerId);
		expect(a).toEqual(b);
		expect(a).toHaveLength(4);
		expect(a.at(-1)).toBe("down");
	});
});

describe("rankCandidatesByStrategy — lifecycle gating", () => {
	it("excludes retired models from the ranking entirely", () => {
		const retired = matchWithStatus("m-retired", "retired-prov", 0.1, "retired");
		const active = matchWithStatus("m-active", "active-prov", 1, "active");
		const state = createRegistryState();
		const ranked = rankCandidatesByStrategy(state, [retired, active], "cheapest");
		// Retired is dropped; only the active route survives.
		expect(ranked).toHaveLength(1);
		expect(ranked[0].providerId).toBe("active-prov");
	});

	it("returns an empty list when every candidate is retired", () => {
		const state = createRegistryState();
		const ranked = rankCandidatesByStrategy(
			state,
			[matchWithStatus("m1", "p1", 1, "retired"), matchWithStatus("m2", "p2", 2, "retired")],
			"cheapest",
		);
		expect(ranked).toEqual([]);
	});

	it("demotes deprecated routes below active routes among otherwise-equal candidates", () => {
		// Two routes with identical price AND identical (unknown) latency →
		// identical balanced composite. The deprecated one must sort after
		// the active one via the status tiebreak, but it is NOT hidden.
		const active = matchWithStatus("m-active", "prov-a", 5, "active");
		const deprecated = matchWithStatus("m-deprecated", "prov-d", 5, "deprecated");
		const state = createRegistryState(); // no observations → both unknown latency
		const ranked = rankCandidatesByStrategy(state, [deprecated, active], "balanced");
		expect(ranked).toHaveLength(2);
		expect(ranked.map((r) => r.providerId)).toEqual(["prov-a", "prov-d"]);
	});

	it("still lets a deprecated route win when its composite is genuinely better", () => {
		// Deprecated but strictly cheaper — its balanced composite is lower,
		// so it ranks first. The demotion only breaks ties; it never hides a
		// clearly-better route.
		const active = matchWithStatus("m-active", "prov-a", 5, "active");
		const deprecated = matchWithStatus("m-deprecated", "prov-d", 1, "deprecated");
		const state = createRegistryState();
		const ranked = rankCandidatesByStrategy(state, [active, deprecated], "balanced");
		expect(ranked[0].providerId).toBe("prov-d");
		expect(ranked).toHaveLength(2);
	});
});
