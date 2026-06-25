/**
 * kosha-discovery — Health-aware route ranking.
 *
 * The cheapest-model query ranks purely on price. This module layers the
 * runtime signal kosha already collects — per-provider circuit-breaker state
 * and rolling latency/timeout observations — on top of that price ranking so
 * callers can route by `fastest`, `reliable`, or a `balanced` blend, not just
 * `cheapest`. It is pure: it reads {@link RegistryState} and returns a ranked
 * projection, mutating nothing (in particular it never calls
 * `breaker.canExecute()`, which would transition open → half-open).
 * @module
 */

import type { CircuitState } from "./resilience.js";
import type { ProviderObservation, RegistryState } from "./registry-state.js";
import type { CheapestModelMatch, ModelCard } from "./types.js";

/** Selection strategy applied on top of the price-filtered candidate set. */
export type RouteStrategy = "cheapest" | "fastest" | "reliable" | "balanced";

/** All known strategies, for validation at the edges (CLI/proxy/MCP). */
export const ROUTE_STRATEGIES: readonly RouteStrategy[] = ["cheapest", "fastest", "reliable", "balanced"];

/** Latency sentinel (ms) used to rank providers with no samples *below* any
 *  provider with a measured latency, without resorting to Infinity (which
 *  would break the balanced-mode min/max normalization). */
const UNKNOWN_LATENCY_MS = 60_000;

/** Per-provider runtime health derived from observations + breaker state. */
export interface RouteHealth {
	providerId: string;
	/** Circuit-breaker state at read time. */
	breakerState: CircuitState;
	/** False when the breaker is open (requests are being rejected). */
	available: boolean;
	/** 95th-percentile latency over the rolling sample window, or null. */
	p95LatencyMs: number | null;
	/** Mean latency over the rolling sample window, or null. */
	avgLatencyMs: number | null;
	/** Fraction of recent attempts that timed out (0..1). */
	timeoutRate: number;
	/** Composite reliability in [0,1]; higher is better. */
	reliabilityScore: number;
	/** Number of latency samples backing the percentile/mean. */
	samples: number;
	/** Last normalized error class observed, if any. */
	lastErrorType: ProviderObservation["lastErrorType"];
}

/** A candidate route annotated with price + health + a strategy-specific score. */
export interface RankedRoute {
	model: ModelCard;
	providerId: string;
	/** Price score (lower is cheaper); null when the model has no usable pricing. */
	price: number | null;
	health: RouteHealth;
	/** Strategy-specific rank key — lower is better. */
	compositeScore: number;
}

/**
 * Compute a read-only health snapshot for one provider from the rolling
 * observation window and the circuit breaker. Never mutates breaker state.
 */
export function providerRouteHealth(state: RegistryState, providerId: string): RouteHealth {
	const breakerState = state.healthTracker.breaker(providerId).health().state;
	const observation = state.providerObservations.get(providerId);
	const samples = observation?.latenciesMs.length ?? 0;
	const timeoutRate = observation && observation.attemptCount > 0
		? observation.timeoutCount / observation.attemptCount
		: 0;

	let reliabilityScore = 1;
	if (breakerState === "open") reliabilityScore = 0;
	else if (breakerState === "half-open") reliabilityScore *= 0.5;
	reliabilityScore *= 1 - timeoutRate;
	// A bad credential makes a provider useless for routing until refreshed;
	// throttling is real but recoverable, so penalize it more gently.
	if (observation?.lastErrorType === "auth_error") reliabilityScore *= 0.1;
	else if (observation?.lastErrorType === "throttled") reliabilityScore *= 0.6;

	return {
		providerId,
		breakerState,
		available: breakerState !== "open",
		p95LatencyMs: percentile(observation?.latenciesMs, 0.95),
		avgLatencyMs: mean(observation?.latenciesMs),
		timeoutRate: Number(timeoutRate.toFixed(3)),
		reliabilityScore: Number(reliabilityScore.toFixed(3)),
		samples,
		lastErrorType: observation?.lastErrorType ?? null,
	};
}

/**
 * Re-rank a price-sorted candidate set by the requested strategy.
 *
 * `cheapest` preserves the incoming price order. The other strategies fold in
 * per-provider health. Unavailable providers (open breaker) are always sorted
 * last regardless of strategy, so failover naturally prefers live providers.
 */
export function rankCandidatesByStrategy(
	state: RegistryState,
	matches: CheapestModelMatch[],
	strategy: RouteStrategy,
): RankedRoute[] {
	const rows = matches.map((match) => {
		const health = providerRouteHealth(state, match.model.provider);
		return {
			model: match.model,
			providerId: match.model.provider,
			price: match.score ?? null,
			health,
			latency: health.p95LatencyMs ?? health.avgLatencyMs ?? UNKNOWN_LATENCY_MS,
		};
	});

	// Balanced needs the candidate-set extremes to normalize price + latency.
	const pricedValues = rows.map((r) => r.price).filter((p): p is number => p !== null);
	const minPrice = pricedValues.length ? Math.min(...pricedValues) : 0;
	const maxPrice = pricedValues.length ? Math.max(...pricedValues) : 0;
	const minLatency = Math.min(...rows.map((r) => r.latency));
	const maxLatency = Math.max(...rows.map((r) => r.latency));

	const scored: RankedRoute[] = rows.map((row, index) => ({
		model: row.model,
		providerId: row.providerId,
		price: row.price,
		health: row.health,
		compositeScore: compositeFor(strategy, row, index, {
			minPrice,
			maxPrice,
			minLatency,
			maxLatency,
		}),
	}));

	// Stable, deterministic ordering: available providers first, then the
	// strategy score, then price, then model id as a final tiebreak.
	return scored.sort((a, b) =>
		Number(b.health.available) - Number(a.health.available) ||
		a.compositeScore - b.compositeScore ||
		(a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY) ||
		a.model.id.localeCompare(b.model.id),
	);
}

interface Extremes {
	minPrice: number;
	maxPrice: number;
	minLatency: number;
	maxLatency: number;
}

function compositeFor(
	strategy: RouteStrategy,
	row: { price: number | null; latency: number; health: RouteHealth },
	index: number,
	ext: Extremes,
): number {
	switch (strategy) {
		case "cheapest":
			// Preserve the caller's incoming price order verbatim.
			return index;
		case "fastest":
			return row.latency;
		case "reliable":
			return 1 - row.health.reliabilityScore;
		case "balanced": {
			const priceN = normalize(row.price ?? ext.maxPrice, ext.minPrice, ext.maxPrice);
			const latencyN = normalize(row.latency, ext.minLatency, ext.maxLatency);
			const reliabilityN = 1 - row.health.reliabilityScore;
			return 0.4 * priceN + 0.3 * latencyN + 0.3 * reliabilityN;
		}
	}
}

/** Min-max normalize into [0,1]; collapses to 0 when the range is degenerate. */
function normalize(value: number, min: number, max: number): number {
	if (max <= min) return 0;
	return (value - min) / (max - min);
}

function mean(values: number[] | undefined): number | null {
	if (!values || values.length === 0) return null;
	return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/** Nearest-rank percentile over a small unsorted sample set. */
function percentile(values: number[] | undefined, p: number): number | null {
	if (!values || values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil(p * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Parse a strategy token; returns undefined for anything unrecognized. */
export function parseRouteStrategy(value: string | undefined | null): RouteStrategy | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	return (ROUTE_STRATEGIES as readonly string[]).includes(normalized)
		? (normalized as RouteStrategy)
		: undefined;
}
