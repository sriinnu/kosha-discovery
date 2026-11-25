/**
 * kosha-discovery — The rates a request actually pays.
 *
 * A card's flat fields hold the short-prompt rates in effect when it was
 * built. Three things can change that per request: an announced price change
 * whose date has passed (`changes`), a long prompt that moves the whole
 * request into a higher band (`bands`), and the cache-write lifetime used
 * (`cacheWrites`). This folds all three into flat rates, so cost code reads
 * one shape. Pure: no clock unless the caller passes none.
 * @module
 */

import type { CacheWriteTier, ModelPricing, PricingBand, PricingChange, PricingSchedule } from "./types.js";

/** One hour, the lifetime `cacheWrite1hPerMillion` mirrors. */
export const ONE_HOUR_TTL_SECONDS = 3600;

export interface ResolveOptions {
	/** When the request runs. Defaults to now. */
	at?: Date | number;
	/** Total prompt tokens: uncached input plus cache reads and writes. */
	promptTokens?: number;
	/** Named upstream service tier (e.g. `"flex"` or `"priority"`), if present on `pricing.serviceTiers`. */
	serviceTier?: string;
}

/** Flat rates for one request, plus which band (if any) it landed in. */
export interface ResolvedPricing extends ModelPricing {
	/** The band the prompt fell into, or null for the base rates. */
	band: PricingBand | null;
}

function timeOf(at: Date | number | undefined): number {
	if (at === undefined) return Date.now();
	return typeof at === "number" ? at : at.getTime();
}

/** Changes whose `effectiveAt` is at or before `at`, oldest first. */
export function changesInEffect(changes: readonly PricingChange[] | undefined, at: number): PricingChange[] {
	return (changes ?? [])
		.filter((change) => {
			const t = Date.parse(change.effectiveAt);
			return Number.isFinite(t) && t <= at;
		})
		.sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt));
}

/** The earliest change still to come, or undefined. */
export function nextChange(changes: readonly PricingChange[] | undefined, at: number): PricingChange | undefined {
	return (changes ?? [])
		.filter((change) => Date.parse(change.effectiveAt) > at)
		.sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt))[0];
}

/**
 * The card's pricing as of `at`: every change that has taken effect is folded
 * into the flat fields (absolute rates, so folding twice changes nothing),
 * the applied changes are dropped from `changes`, and `pricingValidUntil`
 * points at the next one.
 */
export function pricingAsOf<P extends ModelPricing>(pricing: P, at: Date | number = Date.now()): P {
	const t = timeOf(at);
	const due = changesInEffect(pricing.changes, t);
	if (due.length === 0) return pricing;
	let out: P = { ...pricing };
	let syncedDueWrites = false;
	for (const change of due) {
		out = { ...out, ...change.rates };
		if (change.rates.cacheWrites && change.rates.cacheWrites.length > 0) {
			syncedDueWrites = true;
		} else if (
			out.cacheWrites &&
			(change.rates.cacheWritePerMillion !== undefined || change.rates.cacheWrite1hPerMillion !== undefined)
		) {
			const updatedTiers = out.cacheWrites.map((tier) => {
				if (tier.ttlSeconds === ONE_HOUR_TTL_SECONDS && change.rates.cacheWrite1hPerMillion !== undefined) {
					return { ...tier, perMillion: change.rates.cacheWrite1hPerMillion };
				}
				if (tier.ttlSeconds < ONE_HOUR_TTL_SECONDS && change.rates.cacheWritePerMillion !== undefined) {
					return { ...tier, perMillion: change.rates.cacheWritePerMillion };
				}
				return tier;
			});
			out.cacheWrites = updatedTiers;
			syncedDueWrites = true;
		}
		if (change.rates.bands && change.rates.bands.length > 0) {
			const first = change.rates.bands[0];
			out.longContextThresholdTokens = first.aboveInputTokens;
			out.longContextInputPerMillion = first.inputPerMillion;
			out.longContextOutputPerMillion = first.outputPerMillion;
		}
	}
	if (syncedDueWrites) out = syncWriteMirrors(out);
	const pending = (pricing.changes ?? []).filter((change) => !due.includes(change));
	if (pending.length > 0) {
		out.changes = pending;
		out.pricingValidUntil = nextChange(pending, t)?.effectiveAt;
	} else {
		delete out.changes;
		delete out.pricingValidUntil;
	}
	return out;
}

/** Keep `cacheWritePerMillion` / `cacheWrite1hPerMillion` in step with `cacheWrites`. */
export function syncWriteMirrors<P extends ModelPricing>(pricing: P): P {
	const tiers = pricing.cacheWrites;
	if (!tiers || tiers.length === 0) return pricing;
	const sorted = [...tiers].sort((a, b) => a.ttlSeconds - b.ttlSeconds);
	const hour = sorted.find((tier) => tier.ttlSeconds === ONE_HOUR_TTL_SECONDS);
	const out: P = { ...pricing, cacheWrites: sorted, cacheWritePerMillion: sorted[0].perMillion };
	if (hour) out.cacheWrite1hPerMillion = hour.perMillion;
	else delete out.cacheWrite1hPerMillion;
	return out;
}

/** True when `at` falls inside one of `schedule.peakWindows` (UTC). */
export function isInPeakWindow(schedule: PricingSchedule, at: Date | number = Date.now()): boolean {
	const d = typeof at === "number" ? new Date(at) : at;
	const day = d.getUTCDay();
	const hour = d.getUTCHours();
	for (const w of schedule.peakWindows) {
		if (!w.days.includes(day)) continue;
		if (w.startHourUtc <= w.endHourUtc) {
			if (hour >= w.startHourUtc && hour < w.endHourUtc) return true;
		} else if (hour >= w.startHourUtc || hour < w.endHourUtc) {
			return true;
		}
	}
	return false;
}

/** Apply `schedule.offPeak` rates when `at` falls outside peak windows. */
export function pricingForSchedule<P extends ModelPricing>(pricing: P, at: Date | number = Date.now()): P {
	if (!pricing.schedule || isInPeakWindow(pricing.schedule, at)) return pricing;
	const { offPeak } = pricing.schedule;
	const out: P = {
		...pricing,
		inputPerMillion: offPeak.inputPerMillion,
		outputPerMillion: offPeak.outputPerMillion,
		...(offPeak.cacheReadPerMillion !== undefined ? { cacheReadPerMillion: offPeak.cacheReadPerMillion } : {}),
	};
	if (out.cacheWriteBilling === "as-input") {
		out.cacheWritePerMillion = offPeak.inputPerMillion;
	}
	return out;
}

/** The band a prompt of `promptTokens` falls into, or null. */
export function bandFor(
	bands: readonly PricingBand[] | undefined,
	promptTokens: number | undefined,
): PricingBand | null {
	if (!bands || bands.length === 0 || promptTokens === undefined || !(promptTokens > 0)) return null;
	let hit: PricingBand | null = null;
	for (const band of [...bands].sort((a, b) => a.aboveInputTokens - b.aboveInputTokens)) {
		const over = band.inclusive ? promptTokens >= band.aboveInputTokens : promptTokens > band.aboveInputTokens;
		if (over) hit = band;
	}
	return hit;
}

/**
 * The bands a card has: its `bands`, or one built from the legacy
 * `longContext*` fields when only those are set.
 */
export function effectiveBands(pricing: ModelPricing): PricingBand[] {
	if (pricing.bands && pricing.bands.length > 0) return pricing.bands;
	const threshold = pricing.longContextThresholdTokens;
	const input = pricing.longContextInputPerMillion;
	if (!(typeof threshold === "number" && threshold > 0) || typeof input !== "number") return [];
	return [
		{
			aboveInputTokens: threshold,
			inputPerMillion: input,
			outputPerMillion: pricing.longContextOutputPerMillion ?? pricing.outputPerMillion,
		},
	];
}

/**
 * Flat rates for one request: changes in effect at `at`, then the band its
 * prompt falls into. A band that leaves out a cache rate scales the base
 * cache rate by the band's input multiple, which is how every provider
 * listed so far prices it (OpenAI, xAI, Gemini, MiniMax, Haiku 5.5).
 */
export function resolvePricing(pricing: ModelPricing, options: ResolveOptions = {}): ResolvedPricing {
	const at = timeOf(options.at);
	const baseStandard = pricingForSchedule(pricingAsOf(pricing, at), at);
	const tier =
		options.serviceTier && baseStandard.serviceTiers?.[options.serviceTier]
			? baseStandard.serviceTiers[options.serviceTier]
			: undefined;

	const band = bandFor(effectiveBands(baseStandard), options.promptTokens);
	if (!band) {
		if (!tier) return { ...baseStandard, band: null };
		return {
			...baseStandard,
			inputPerMillion: tier.inputPerMillion,
			outputPerMillion: tier.outputPerMillion,
			...(tier.cacheReadPerMillion !== undefined ? { cacheReadPerMillion: tier.cacheReadPerMillion } : {}),
			band: null,
		};
	}

	const scale =
		baseStandard.inputPerMillion > 0
			? band.inputPerMillion / baseStandard.inputPerMillion
			: baseStandard.outputPerMillion > 0
				? band.outputPerMillion / baseStandard.outputPerMillion
				: 1;
	const scaleRate = (rate: number | undefined) => (typeof rate === "number" ? rate * scale : undefined);
	const tierInput =
		tier && baseStandard.inputPerMillion > 0
			? band.inputPerMillion * (tier.inputPerMillion / baseStandard.inputPerMillion)
			: (tier?.inputPerMillion ?? band.inputPerMillion);
	const tierOutput =
		tier && baseStandard.outputPerMillion > 0
			? band.outputPerMillion * (tier.outputPerMillion / baseStandard.outputPerMillion)
			: (tier?.outputPerMillion ?? band.outputPerMillion);

	const writes: CacheWriteTier[] | undefined =
		band.cacheWrites ?? baseStandard.cacheWrites?.map((t) => ({ ...t, perMillion: t.perMillion * scale }));
	const resolved: ResolvedPricing = {
		...baseStandard,
		inputPerMillion: tierInput,
		outputPerMillion: tierOutput,
		band,
	};
	const read = tier?.cacheReadPerMillion !== undefined
		? tier.cacheReadPerMillion * scale
		: (band.cacheReadPerMillion ?? scaleRate(baseStandard.cacheReadPerMillion));
	if (read !== undefined) resolved.cacheReadPerMillion = read;
	if (writes) {
		resolved.cacheWrites = writes;
		const synced = syncWriteMirrors({ ...resolved, cacheWrites: writes });
		resolved.cacheWrites = synced.cacheWrites;
		resolved.cacheWritePerMillion = synced.cacheWritePerMillion;
		if (synced.cacheWrite1hPerMillion !== undefined) resolved.cacheWrite1hPerMillion = synced.cacheWrite1hPerMillion;
		else delete resolved.cacheWrite1hPerMillion;
	} else {
		const write = scaleRate(baseStandard.cacheWritePerMillion);
		if (write !== undefined) resolved.cacheWritePerMillion = write;
		const write1h = scaleRate(baseStandard.cacheWrite1hPerMillion);
		if (write1h !== undefined) resolved.cacheWrite1hPerMillion = write1h;
	}
	return resolved;
}

/** The write rate for a lifetime: the exact tier, else the shortest tier at least that long. */
export function writeRateFor(pricing: ModelPricing, ttlSeconds: number): number | undefined {
	const tiers = [...(pricing.cacheWrites ?? [])].sort((a, b) => a.ttlSeconds - b.ttlSeconds);
	const exact = tiers.find((tier) => tier.ttlSeconds === ttlSeconds);
	if (exact) return exact.perMillion;
	if (ttlSeconds === ONE_HOUR_TTL_SECONDS && pricing.cacheWrite1hPerMillion !== undefined)
		return pricing.cacheWrite1hPerMillion;
	return tiers.find((tier) => tier.ttlSeconds >= ttlSeconds)?.perMillion;
}
