/**
 * cli-pricing-detail.ts — The pricing lines `kosha model` prints beyond the
 * headline: cache writes by lifetime, storage, long-prompt bands, dated
 * changes, and the page a cited price came from.
 * @module
 */

import { formatPrice } from "./cli-format.js";
import { isInPeakWindow } from "./pricing-resolve.js";
import type { CacheWriteTier, ModelPricing, PricingBand, PricingSchedule } from "./types.js";

export { formatPrice };

/** `300` → `5m`, `3600` → `1h`, `43200` → `12h`. */
export function formatTtl(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

/** `272000` → `272K`, `1000000` → `1M`. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
	if (tokens >= 1000 && tokens % 1000 === 0) return `${tokens / 1000}K`;
	return String(tokens);
}

function writes(tiers: readonly CacheWriteTier[]): string {
	return tiers.map((tier) => `${formatTtl(tier.ttlSeconds)} ${formatPrice(tier.perMillion)}`).join(" / ");
}

/** The cache line: read, then writes by lifetime or the single write rate, and how writes bill. */
export function cacheLine(pricing: ModelPricing): string | null {
	const parts: string[] = [];
	if (pricing.cacheReadPerMillion !== undefined) parts.push(`${formatPrice(pricing.cacheReadPerMillion)} read`);
	if (pricing.cacheWriteBilling === "as-input") parts.push("writes bill as input (no premium)");
	else if (pricing.cacheWrites && pricing.cacheWrites.length > 0) parts.push(`write ${writes(pricing.cacheWrites)}`);
	else if (pricing.cacheWritePerMillion !== undefined) {
		const h1 = pricing.cacheWrite1hPerMillion;
		parts.push(
			`${formatPrice(pricing.cacheWritePerMillion)} write${h1 !== undefined ? ` / 1h ${formatPrice(h1)}` : ""}`,
		);
	}
	if (pricing.cacheStoragePerMillionPerHour !== undefined)
		parts.push(`storage ${formatPrice(pricing.cacheStoragePerMillionPerHour)}/hour`);
	return parts.length > 0 ? `${parts.join(", ")} per million tokens` : null;
}

function bandLine(band: PricingBand): string {
	const edge = band.inclusive ? "from" : "over";
	const parts = [`${formatPrice(band.inputPerMillion)} / ${formatPrice(band.outputPerMillion)} in/out`];
	if (band.cacheReadPerMillion !== undefined) parts.push(`${formatPrice(band.cacheReadPerMillion)} read`);
	if (band.cacheWrites?.length) parts.push(`write ${writes(band.cacheWrites)}`);
	return `${edge} ${formatTokens(band.aboveInputTokens)} prompt tokens: ${parts.join(", ")} (whole request)`;
}

/** Long-prompt bands, one line each, from `bands` or the legacy `longContext*` fields. */
export function bandLines(pricing: ModelPricing): string[] {
	if (pricing.bands?.length) return pricing.bands.map(bandLine);
	if (pricing.longContextThresholdTokens && pricing.longContextInputPerMillion !== undefined) {
		return [
			bandLine({
				aboveInputTokens: pricing.longContextThresholdTokens,
				inputPerMillion: pricing.longContextInputPerMillion,
				outputPerMillion: pricing.longContextOutputPerMillion ?? pricing.outputPerMillion,
			}),
		];
	}
	return [];
}

/** Announced changes, one line each: the date and what it moves to. */
export function changeLines(pricing: ModelPricing): string[] {
	return (pricing.changes ?? []).map((change) => {
		const r = change.rates;
		const parts: string[] = [];
		if (r.inputPerMillion !== undefined || r.outputPerMillion !== undefined)
			parts.push(
				`${formatPrice(r.inputPerMillion ?? pricing.inputPerMillion)} / ${formatPrice(r.outputPerMillion ?? pricing.outputPerMillion)} in/out`,
			);
		if (r.cacheReadPerMillion !== undefined) parts.push(`${formatPrice(r.cacheReadPerMillion)} read`);
		if (r.cacheWritePerMillion !== undefined) parts.push(`${formatPrice(r.cacheWritePerMillion)} write`);
		if (r.cacheWrite1hPerMillion !== undefined) parts.push(`1h ${formatPrice(r.cacheWrite1hPerMillion)} write`);
		if (r.cacheStoragePerMillionPerHour !== undefined)
			parts.push(`storage ${formatPrice(r.cacheStoragePerMillionPerHour)}/hour`);
		if (r.batchInputPerMillion !== undefined || r.batchOutputPerMillion !== undefined) {
			parts.push(
				`batch ${formatPrice(r.batchInputPerMillion)} / ${formatPrice(r.batchOutputPerMillion)}`,
			);
		}
		if (r.bands?.length) parts.push(`${r.bands.length} band(s)`);
		return `from ${change.effectiveAt.slice(0, 10)}: ${parts.join(", ")}`;
	});
}

function formatPeakWindows(windows: PricingSchedule["peakWindows"]): string {
	return windows
		.map((w) => `${String(w.startHourUtc).padStart(2, "0")}:00-${String(w.endHourUtc).padStart(2, "0")}:00 UTC`)
		.join(", ");
}

/** Off-peak rates and peak schedule, when the provider varies price by UTC hour. */
export function scheduleLine(pricing: ModelPricing, now: Date | number = Date.now()): string | null {
	const s = pricing.schedule;
	if (!s) return null;
	const off = s.offPeak;
	const rates = [
		`${formatPrice(off.inputPerMillion)} / ${formatPrice(off.outputPerMillion)} in/out`,
		...(off.cacheReadPerMillion !== undefined ? [`${formatPrice(off.cacheReadPerMillion)} read`] : []),
	].join(", ");
	const status = isInPeakWindow(s, now) ? "peak now" : "off-peak now";
	const windows = s.peakWindows.length > 0 ? `; peak Mon-Fri ${formatPeakWindows(s.peakWindows)}` : "";
	return `${rates} per million tokens (${status}${windows})`;
}

/** Every extra pricing line for `kosha model`, each prefixed `\n<label> `. */
export function pricingDetail(
	pricing: ModelPricing | undefined,
	label: (text: string) => string,
	now: Date | number = Date.now(),
): string {
	if (!pricing) return "";
	let out = "";
	const cache = cacheLine(pricing);
	if (cache) out += `\n${label("Cache Pricing:")} ${cache}`;
	const offPeak = scheduleLine(pricing, now);
	if (offPeak) out += `\n${label("Off-Peak Pricing:")} ${offPeak}`;
	for (const line of bandLines(pricing)) out += `\n${label("Long Prompts:")} ${line}`;
	for (const line of changeLines(pricing)) out += `\n${label("Price Change:")} ${line}`;
	if (pricing.citation)
		out += `\n${label("Price Source:")} ${pricing.citation.source} (checked ${pricing.citation.checkedAt})`;
	return out;
}
