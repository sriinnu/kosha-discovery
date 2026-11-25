/**
 * kosha-discovery — Pricing-diff anomaly detection and rolling 30-day log.
 *
 * Compares previous vs fresh snapshots at manifest merge time and records moves
 * above 25% into `<manifest-dir>/anomalies.json`, skipping kosha's own cited
 * prices, curated schedules, and unreported $0 secondary-rate drops.
 * @module
 */

import { randomBytes } from "crypto";
import { rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import type { DiscoverySnapshotV1 } from "./discovery-contract.js";
import { citedFieldsMatching, isCuratedSchedule, keepReportedSecondaryRates } from "./manifest-merge.js";

/**
 * A single pricing-diff event captured at merge time. Persisted to
 * `<manifest-dir>/anomalies.json` so consumers can surface "rate moved
 * unexpectedly" as a UI signal without polling for every merge.
 */
export interface PricingAnomaly {
	ts: number;
	/** Stable model key, e.g. `anthropic:claude-opus-4-7`. */
	key: string;
	/** Which rate moved: `input`, `output`, `cacheRead`, `cacheWrite`, `cacheWrite1h`. */
	field: "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h";
	/** Whether the change was on `originPricing` (direct) or `pricing` (proxy). */
	side: "origin" | "proxy";
	previous: number;
	current: number;
	/** Signed fractional delta, e.g. -0.5 = 50% drop, +1.0 = doubled. */
	deltaPct: number;
	/** True when either snapshot carried a promo_override tag for this model. */
	promo: boolean;
}

const ANOMALY_DELTA_THRESHOLD = 0.25; // 25% in either direction
const ANOMALY_RETENTION_MS = 30 * 86_400_000; // 30 days
const ANOMALY_MAX_ENTRIES = 5_000; // cap so the file can't grow unbounded
export const ANOMALY_FILE = "anomalies.json";

function hasPromoFlag(entry: { capabilities?: string[]; rawCapabilities?: string[] } | undefined): boolean {
	if (!entry) return false;
	const caps = entry.rawCapabilities ?? entry.capabilities ?? [];
	return caps.includes("promo_override");
}

/** Compare prev vs fresh manifests and emit one anomaly per rate-field
 *  that moved more than ANOMALY_DELTA_THRESHOLD, excluding kosha's own
 *  curated schedules and cited price changes. */
export function detectPricingAnomalies(
	previous: DiscoverySnapshotV1 | null,
	fresh: DiscoverySnapshotV1,
): PricingAnomaly[] {
	if (!previous?.models) return [];
	const prevByKey = new Map<string, (typeof previous.models)[number]>();
	for (const m of previous.models) {
		if (m.key) prevByKey.set(m.key, m);
	}
	const now = fresh.discoveredAt ?? Date.now();
	const ts = Date.now();
	const anomalies: PricingAnomaly[] = [];

	type RateBlock =
		| {
				inputPerMillion?: number;
				outputPerMillion?: number;
				cacheReadPerMillion?: number;
				cacheWritePerMillion?: number;
				cacheWrite1hPerMillion?: number;
		  }
		| null
		| undefined;
	const fields: { name: PricingAnomaly["field"]; key: keyof NonNullable<RateBlock> }[] = [
		{ name: "input", key: "inputPerMillion" },
		{ name: "output", key: "outputPerMillion" },
		{ name: "cacheRead", key: "cacheReadPerMillion" },
		{ name: "cacheWrite", key: "cacheWritePerMillion" },
		{ name: "cacheWrite1h", key: "cacheWrite1hPerMillion" },
	];
	const sides: {
		name: PricingAnomaly["side"];
		pick: (m: { pricing?: RateBlock; originPricing?: RateBlock }) => RateBlock;
	}[] = [
		{ name: "origin", pick: (m) => m.originPricing },
		{ name: "proxy", pick: (m) => m.pricing },
	];

	for (const f of fresh.models ?? []) {
		if (!f.key) continue;
		if (isCuratedSchedule(f)) continue;
		const prev = prevByKey.get(f.key);
		if (!prev) continue;
		const cited = citedFieldsMatching(f, now);
		const normalizedFresh = keepReportedSecondaryRates(prev, f, cited);
		for (const side of sides) {
			const a = side.pick(prev as { pricing?: RateBlock; originPricing?: RateBlock });
			const b = side.pick(normalizedFresh as { pricing?: RateBlock; originPricing?: RateBlock });
			if (!a || !b) continue;
			for (const field of fields) {
				if (side.name === "proxy" && cited.includes(field.key)) continue;
				const prevRate = a[field.key];
				const newRate = b[field.key];
				if (typeof prevRate !== "number" || typeof newRate !== "number") continue;
				if (prevRate === 0) continue; // can't compute delta from zero baseline; skip
				if (prevRate === newRate) continue;
				const delta = (newRate - prevRate) / prevRate;
				if (Math.abs(delta) < ANOMALY_DELTA_THRESHOLD) continue;
				anomalies.push({
					ts,
					key: f.key,
					field: field.name,
					side: side.name,
					previous: prevRate,
					current: newRate,
					deltaPct: delta,
					promo: hasPromoFlag(prev) || hasPromoFlag(f),
				});
			}
		}
	}
	return anomalies;
}

/**
 * Drop anomalies the log already ends on. A quarantined rate keeps the old
 * price in the manifest, so every export sees the same move again; logging
 * each one printed the same 172 lines on every run and pushed real changes
 * out of the capped log. A price that moves away and back is still logged.
 */
export function unloggedAnomalies(existing: PricingAnomaly[], fresh: PricingAnomaly[]): PricingAnomaly[] {
	const latest = new Map<string, PricingAnomaly>();
	const id = (a: PricingAnomaly) => `${a.key}|${a.side}|${a.field}`;
	for (const a of existing) latest.set(id(a), a);
	return fresh.filter((a) => {
		const last = latest.get(id(a));
		return !last || last.previous !== a.previous || last.current !== a.current;
	});
}

/** Append new anomalies to <manifestDir>/anomalies.json and return how many
 *  there were. Atomic write, rolling retention (30 days OR last 5000 entries,
 *  whichever is tighter). */
export async function appendAnomalies(manifestDir: string, detected: PricingAnomaly[]): Promise<number> {
	const path = join(manifestDir, ANOMALY_FILE);
	const cutoff = Date.now() - ANOMALY_RETENTION_MS;
	let existing: PricingAnomaly[] = [];
	try {
		const { readFile } = await import("fs/promises");
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as { anomalies?: PricingAnomaly[] };
		if (Array.isArray(parsed.anomalies)) existing = parsed.anomalies;
	} catch {
		// missing or unreadable — start fresh
	}
	const fresh = unloggedAnomalies(existing, detected);
	if (fresh.length === 0) return 0;
	const all = [...existing, ...fresh].filter((a) => a.ts >= cutoff).slice(-ANOMALY_MAX_ENTRIES);
	const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify({ schemaVersion: 1, anomalies: all }, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
	return fresh.length;
}

/** Read recorded pricing anomalies from <manifestDir>/anomalies.json (returns [] when absent). */
export async function readAnomalies(manifestDir: string): Promise<PricingAnomaly[]> {
	try {
		const { readFile } = await import("fs/promises");
		const raw = await readFile(join(manifestDir, ANOMALY_FILE), "utf-8");
		const parsed = JSON.parse(raw) as { anomalies?: PricingAnomaly[] };
		return Array.isArray(parsed.anomalies) ? parsed.anomalies : [];
	} catch {
		return [];
	}
}
