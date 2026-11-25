/**
 * kosha-discovery — Pure manifest merge, price quarantine, and anchor rules.
 *
 * Zero I/O: compares the previous manifest baseline against a freshly discovered
 * snapshot, enforces hold windows / collapse floors / 30-day anchors, and
 * projects those verdicts back onto in-memory provider cards.
 * @module
 */

import { citedFields, citedPriceFor, citedPricing } from "./discovery/cited-prices.js";
import { applyFreeTierFlag } from "./discovery/free-tier.js";
import { type PriceEvidence, priceAgreement } from "./discovery/price-evidence.js";
import { SCHEDULED_PRICES } from "./discovery/price-schedules.js";
import type { DiscoverySnapshotV1 } from "./discovery-contract.js";
import { PRICE_RATE_FIELDS, sanitizeModelPricing } from "./price-trust.js";
import type { RegistryState } from "./registry-state.js";
import type { ModelCard, ModelPricing } from "./types.js";

/** Beyond this fractional rate change in either direction, we treat a fresh
 *  price as suspect and keep the previous value (quarantine). The 25% delta
 *  used by anomaly logging is a UI-alert threshold; quarantine fires only on
 *  a much larger swing so legitimate price updates aren't blocked. */
export const PRICING_QUARANTINE_THRESHOLD = 0.75;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Quarantine guards against a bad publish, but a real move must not stay refused
 *  forever. Two independent sources agreeing is strong evidence, so that's a day. */
const PRICING_AGREED_HOLD_MS = DAY_MS;

/** One source can't vouch for itself, and a compromised one can simply wait out
 *  the hold. So it waits longer, and the row stays flagged once it's accepted. */
const PRICING_SINGLE_SOURCE_HOLD_MS = 3 * DAY_MS;

/** Sources can stay apart for good: one going stale after a real move would
 *  otherwise pin the old price forever. So a dispute waits longest, and the row
 *  stays flagged once it's accepted. */
const PRICING_DISPUTED_HOLD_MS = 7 * DAY_MS;

/** The accepted price rests on one source's word. */
const PRICING_SINGLE_SOURCE = "pricing_single_source";

/** Sources list different prices for this model. */
export const PRICING_SOURCES_DISAGREE = "pricing_sources_disagree";

/** Tags the manifest merge puts on a price that isn't settled. */
export const PRICE_HOLD_TAGS = ["pricing_quarantined", PRICING_SOURCES_DISAGREE, PRICING_SINGLE_SOURCE] as const;

/** A previously-known model missing from fresh snapshots for longer than this
 *  is dropped from the merged manifest. Prevents the manifest from becoming a
 *  graveyard of deprecated SKUs while still riding through outages. */
const MISSING_MODEL_TTL_MS = 30 * DAY_MS;

/** The rates a quarantined row is waiting on, when they were first seen, and
 *  whether someone accepted them with `kosha registry accept`. */
export interface PricingHold {
	rates: string;
	since: number;
	accepted?: boolean;
}

/**
 * The highest accepted headline price in the recent past. Each move is
 * compared to the last accepted price too, but that alone lets a price walk
 * down in steps just under the threshold: three 74% cuts take $10 to $0.18.
 * The anchor remembers where the price stood, so the walk is caught.
 */
export interface PriceAnchor {
	inputPerMillion?: number;
	outputPerMillion?: number;
	/** When the anchor was last raised or reset (epoch ms). */
	at: number;
}

type PricedSides = { pricing?: unknown; originPricing?: unknown };
type Rates = Record<string, unknown> | null | undefined;

/** Every rate that bills or ranks. The long-context threshold is a token
 *  count, not a price, so it isn't compared. */
const QUARANTINE_FIELDS = PRICE_RATE_FIELDS.filter((field) => field !== "longContextThresholdTokens");

/** The billed rates that decide a model's headline price. */
const HEADLINE_FIELDS = new Set<string>(["inputPerMillion", "outputPerMillion"]);

/** A billed rate below this share of the one it replaces counts as a collapse,
 *  like $0: never accepted by waiting. */
const PRICING_COLLAPSE_RATIO = 0.01;

/** How long a high price stays the anchor before the current one replaces it. */
const PRICE_ANCHOR_WINDOW_MS = 30 * DAY_MS;

/** A fresh headline rate below this share of the anchor is suspect: one real
 *  50% cut passes, a second inside the window waits. */
const PRICE_ANCHOR_FLOOR = 0.5;

/** A fresh headline rate above this multiple of the anchor is suspect. */
const PRICE_ANCHOR_CEILING = 4;

const PRICE_HOLD_TAG_SET = new Set<string>(PRICE_HOLD_TAGS);

/** Remove transient merge hold tags from incoming cards so mergeManifests is the sole producer. */
function stripHoldTags(tags: string[]): string[];
function stripHoldTags(tags: string[] | undefined): string[] | undefined;
function stripHoldTags(tags: string[] | undefined): string[] | undefined {
	if (!tags) return undefined;
	if (!tags.some((t) => PRICE_HOLD_TAG_SET.has(t))) return tags;
	return tags.filter((t) => !PRICE_HOLD_TAG_SET.has(t));
}

export function mergeManifests(
	previous: DiscoverySnapshotV1 | null,
	fresh: DiscoverySnapshotV1,
	options?: { scopedProviders?: readonly string[] },
): DiscoverySnapshotV1 {
	if (!previous) {
		// Nothing to judge against yet, but every price seen now is the anchor
		// the next run is checked against.
		const seen = fresh.discoveredAt ?? Date.now();
		return {
			...fresh,
			models: (fresh.models ?? []).map((m) => {
				const cleanTags = stripHoldTags(m.rawCapabilities);
				const base = cleanTags !== m.rawCapabilities ? { ...m, rawCapabilities: cleanTags } : m;
				return withAnchor({ ...base, lastSeenAt: seen } as typeof m & { lastSeenAt: number }, null, seen);
			}),
		};
	}

	// Index previous entries by key so we can both detect collisions AND
	// look back at the old data for pricing-degraded merge below.
	const previousByKey = new Map<string, (typeof previous.models)[number]>();
	for (const m of previous.models) {
		if (m.key) previousByKey.set(m.key, m);
	}

	const now = fresh.discoveredAt ?? Date.now();
	const freshModelKeys = new Set<string>();
	const mergedModels: (typeof fresh.models)[number][] = [];
	for (const rawFresh of fresh.models ?? []) {
		const cleanCaps = stripHoldTags(rawFresh.rawCapabilities);
		const f = cleanCaps !== rawFresh.rawCapabilities ? { ...rawFresh, rawCapabilities: cleanCaps } : rawFresh;
		if (f.key) freshModelKeys.add(f.key);
		const old = f.key ? previousByKey.get(f.key) : undefined;

		// The day kosha first saw a model, for ones no catalog dates. Only a model
		// that arrives after a previous manifest gets one: a first run can't tell
		// a new model from an old one.
		const firstSeenAt = old ? (old as { firstSeenAt?: number }).firstSeenAt : now;
		let kept = {
			...f,
			missingRunCount: 0,
			lastSeenAt: now,
			...(firstSeenAt !== undefined ? { firstSeenAt } : {}),
		} as (typeof fresh.models)[number] & {
			missingRunCount?: number;
		};
		// A secondary rate (cache, audio, image…) that falls from a price to 0
		// reads as "not reported" in the catalogs, but billing it at 0 would
		// undercount spend. Keep the last real rate instead.
		const cited = old ? citedFieldsMatching(f, now) : [];
		if (old) kept = keepReportedSecondaryRates(old, kept, cited);
		const anchor = old ? liveAnchor(old, now) : null;
		let resetAnchor = false;
		// Cited fields are kosha's own reading of the provider's page, so the
		// merge judges only the rest: a cited move (Gemini 4's Dec 1 doubling)
		// takes effect on its day instead of waiting out a hold, and resets the
		// anchor when the cited headline rate changed so later minor moves don't
		// falsely quarantine against the superseded rate.
		const citedMovedHeadline =
			old !== undefined &&
			cited.some(
				(field) => HEADLINE_FIELDS.has(field) && (old.pricing as Rates)?.[field] !== (kept.pricing as Rates)?.[field],
			);
		if (citedMovedHeadline) resetAnchor = true;
		const judged = old && cited.length > 0 ? withFields(kept, old, cited) : kept;
		if (old && !hasUsablePricing(f) && hasUsablePricing(old)) {
			// Keep all of fresh's metadata but restore pricing from old.
			kept = { ...kept, pricing: old.pricing, originPricing: old.originPricing };
		} else if (old && !isCuratedSchedule(f) && priceMoveSuspect(old, judged, anchor)) {
			// A scheduled price is curated and cited, not a catalog's publish, so
			// it skips quarantine. Otherwise the first move to it would be refused
			// on every run. Only kosha's own schedule table counts: a `schedule`
			// field carried in by a snapshot or a local file proves nothing.
			const rates = pricingFingerprint(kept);
			const hold = (old as { pricingHold?: PricingHold }).pricingHold;
			const same = hold !== undefined && (hold.rates === rates || hold.rates === legacyPricingFingerprint(kept));
			const since = same ? hold.since : now;
			const accepted = same && hold.accepted === true;
			const agreement = priceAgreement((f as { priceEvidence?: PriceEvidence[] }).priceEvidence);
			const window =
				agreement === "agree"
					? PRICING_AGREED_HOLD_MS
					: agreement === "disagree"
						? PRICING_DISPUTED_HOLD_MS
						: PRICING_SINGLE_SOURCE_HOLD_MS;
			// A billed rate that collapses to $0, or to under 1% of what it was, is
			// never accepted by waiting: it poisons cheapest routing however long
			// it's published. Only `kosha registry accept` releases it.
			if (!accepted && (billedRateCollapsed(old, kept) || now - since < window)) {
				let tags = tagCapability(kept.rawCapabilities, "pricing_quarantined");
				if (agreement === "disagree") tags = tagCapability(tags, PRICING_SOURCES_DISAGREE);
				kept = {
					...kept,
					pricing: cited.length > 0 ? withFields(old, kept, cited).pricing : old.pricing,
					originPricing: old.originPricing,
					rawCapabilities: tags,
					pricingHold: { rates, since },
				} as typeof kept;
			} else {
				// The held move was accepted (explicitly or after its wait window):
				// reset the anchor to the newly accepted rates so small follow-up
				// moves aren't re-quarantined against the superseded high anchor.
				resetAnchor = true;
				if (agreement !== "agree") {
					const flag = agreement === "single" ? PRICING_SINGLE_SOURCE : PRICING_SOURCES_DISAGREE;
					kept = { ...kept, rawCapabilities: tagCapability(kept.rawCapabilities, flag) };
				}
			}
		} else if (old && !isCuratedSchedule(f)) {
			// Below the quarantine line a price still takes effect, but a move its
			// sources dispute is the believable lie, so it carries a flag. Flags
			// from an earlier move last until the rates change or the evidence does.
			const agreement = priceAgreement((f as { priceEvidence?: PriceEvidence[] }).priceEvidence);
			const moved = pricingFingerprint(old) !== pricingFingerprint(judged);
			const wasTagged = (tag: string) => !moved && (old.rawCapabilities ?? []).includes(tag);
			let tags = kept.rawCapabilities;
			if (agreement === "disagree" && (moved || wasTagged(PRICING_SOURCES_DISAGREE))) {
				tags = tagCapability(tags, PRICING_SOURCES_DISAGREE);
			}
			if (agreement === "single" && wasTagged(PRICING_SINGLE_SOURCE)) {
				tags = tagCapability(tags, PRICING_SINGLE_SOURCE);
			}
			if (tags !== kept.rawCapabilities) kept = { ...kept, rawCapabilities: tags };
		}
		mergedModels.push(withAnchor(kept, resetAnchor ? null : anchor, now));
	}
	const scopedSet =
		options?.scopedProviders && options.scopedProviders.length > 0 ? new Set(options.scopedProviders) : null;

	for (const old of previous.models) {
		if (!old.key || freshModelKeys.has(old.key)) continue;
		if (scopedSet && !scopedSet.has(old.providerId)) {
			// A scoped refresh never queried other providers — preserve their rows
			// verbatim without advancing missingRunCount toward the 30d expiry.
			mergedModels.push(old);
			continue;
		}
		const prevMissing = (old as { missingRunCount?: number }).missingRunCount ?? 0;
		const lastSeenAt = (old as { lastSeenAt?: number }).lastSeenAt ?? previous.discoveredAt ?? now;
		if (now - lastSeenAt > MISSING_MODEL_TTL_MS) continue; // drop after TTL
		mergedModels.push({ ...old, missingRunCount: prevMissing + 1, lastSeenAt } as typeof old);
	}

	const prevProviderById = new Map((previous.providers ?? []).map((p) => [p.providerId, p]));
	const mergedProviders = (fresh.providers ?? []).map((p) => {
		if (scopedSet && !scopedSet.has(p.providerId)) {
			return prevProviderById.get(p.providerId) ?? p;
		}
		return p;
	});
	const mergedProviderIds = new Set(mergedProviders.map((p) => p.providerId));
	for (const old of previous.providers ?? []) {
		if (!mergedProviderIds.has(old.providerId)) {
			mergedProviders.push(old);
		}
	}

	return {
		...fresh,
		models: mergedModels,
		providers: mergedProviders,
	};
}

/**
 * Copy the merge's price verdicts onto the in-memory registry. A quarantined
 * row carries the held (previous) price, which replaces the suspect one in
 * memory; dispute and single-source flags are copied onto rawCapabilities so
 * every reader sees them. A secondary rate (cache, audio, image…) the merge
 * kept because a catalog reported it as 0 is copied back too, as is pricing
 * restored onto a degraded-fresh card. Rows the manifest kept for a model
 * this run didn't see are ignored. Returns true when anything in memory changed.
 */
export function applyManifestHolds(state: RegistryState, manifest: DiscoverySnapshotV1): boolean {
	const rows = new Map<string, DiscoverySnapshotV1["models"][number]>();
	for (const row of manifest.models ?? []) rows.set(`${row.providerId}\u0000${row.modelId}`, row);
	if (rows.size === 0) return false;
	let changed = false;
	for (const [providerId, providerInfo] of state.providerMap) {
		let touched = false;
		const models = providerInfo.models.map((original) => {
			const row = rows.get(`${providerId}\u0000${original.id}`);
			if (!row) return original;
			let model = keepReportedSecondaryRates(row, original);
			const firstSeenAt = (row as { firstSeenAt?: number }).firstSeenAt;
			if (typeof firstSeenAt === "number" && model.firstSeenAt !== firstSeenAt) model = { ...model, firstSeenAt };
			const next: ModelCard = { ...model };
			const before = model.rawCapabilities ?? [];
			const rowTags = new Set(row.rawCapabilities ?? []);
			let tags = before.filter((tag) => !PRICE_HOLD_TAG_SET.has(tag) || rowTags.has(tag));
			for (const tag of PRICE_HOLD_TAGS) {
				if (rowTags.has(tag) && !tags.includes(tag)) tags = [...tags, tag];
			}
			let differs = model !== original || tags.length !== before.length || tags.some((t, i) => t !== before[i]);
			if (differs || tags.length > 0) next.rawCapabilities = tags;
			if (!model.pricing && row.pricing) {
				next.pricing = row.pricing;
				differs = true;
			}
			if (!model.originPricing && row.originPricing) {
				next.originPricing = row.originPricing;
				differs = true;
			}
			const quarantined = (row.rawCapabilities ?? []).includes("pricing_quarantined");
			const disputed = (row.rawCapabilities ?? []).includes(PRICING_SOURCES_DISAGREE);
			if (quarantined || disputed) {
				// While a price is held or disputed, kosha routes and budgets on the
				// highest rate anyone reported: the held one, the fresh one and each
				// source's. Overpaying in the estimate is safe; undercounting isn't.
				const base = quarantined ? (row.pricing ?? null) : (model.pricing ?? null);
				const evidence = model.priceEvidence ?? row.priceEvidence ?? [];
				const held = base
					? (sanitizeModelPricing({ ...model, pricing: highestRates(base, model.pricing ?? null, evidence) }).pricing ??
						null)
					: null;
				if (JSON.stringify(held) !== JSON.stringify(model.pricing ?? null)) {
					differs = true;
					if (held) next.pricing = held;
					else delete next.pricing;
				}
				if (quarantined && JSON.stringify(row.originPricing ?? null) !== JSON.stringify(model.originPricing ?? null)) {
					differs = true;
					if (row.originPricing) next.originPricing = row.originPricing;
					else delete next.originPricing;
				}
			}
			const cleaned = applyFreeTierFlag(next);
			if (!differs && cleaned === next) return original;
			touched = true;
			return cleaned;
		});
		if (touched) {
			state.providerMap.set(providerId, { ...providerInfo, models });
			changed = true;
		}
	}
	return changed;
}

/**
 * Each rate at the highest of `base`, `other` and the sources' headline rates.
 * Also keeps nested `cacheWrites` tiers and `bands` consistent with raised headline
 * rates so `writeRateFor` and `resolvePricing` never read a stale lower mirror.
 */
export function highestRates(base: ModelPricing, other: ModelPricing | null, evidence: PriceEvidence[]): ModelPricing {
	const out: Record<string, unknown> = { ...base };
	for (const field of QUARANTINE_FIELDS) {
		const current = out[field];
		const fresh = (other as Record<string, unknown> | null)?.[field];
		let highest: number | undefined = typeof current === "number" && Number.isFinite(current) ? current : undefined;
		if (typeof fresh === "number" && Number.isFinite(fresh)) {
			highest = highest === undefined ? fresh : Math.max(highest, fresh);
		}
		if (field === "inputPerMillion" || field === "outputPerMillion") {
			for (const entry of evidence) {
				const evVal = entry[field];
				if (typeof evVal === "number" && Number.isFinite(evVal)) {
					highest = highest === undefined ? evVal : Math.max(highest, evVal);
				}
			}
		}
		if (highest !== undefined) out[field] = highest;
	}
	// Keep cacheWrites tiers aligned with raised cacheWritePerMillion / cacheWrite1hPerMillion.
	const cw = typeof out.cacheWritePerMillion === "number" ? out.cacheWritePerMillion : undefined;
	const cw1h = typeof out.cacheWrite1hPerMillion === "number" ? out.cacheWrite1hPerMillion : undefined;
	if (Array.isArray(out.cacheWrites)) {
		out.cacheWrites = (out.cacheWrites as Array<{ ttlSeconds: number; perMillion: number }>).map((tier) => {
			if (tier.ttlSeconds === 3600 && cw1h !== undefined)
				return { ...tier, perMillion: Math.max(tier.perMillion, cw1h) };
			if (tier.ttlSeconds <= 300 && cw !== undefined) return { ...tier, perMillion: Math.max(tier.perMillion, cw) };
			return tier;
		});
	}
	// Keep long-context bands >= headline floors when input/output rose.
	if (Array.isArray(out.bands)) {
		const floorIn = typeof out.inputPerMillion === "number" ? out.inputPerMillion : 0;
		const floorOut = typeof out.outputPerMillion === "number" ? out.outputPerMillion : 0;
		out.bands = (
			out.bands as Array<{ aboveInputTokens: number; inputPerMillion: number; outputPerMillion: number }>
		).map((band) => ({
			...band,
			inputPerMillion: Math.max(band.inputPerMillion, floorIn),
			outputPerMillion: Math.max(band.outputPerMillion, floorOut),
		}));
	}
	return out as unknown as ModelPricing;
}

function pricingFingerprint(model: PricedSides): string {
	return JSON.stringify(
		[model.pricing, model.originPricing].map((side) =>
			QUARANTINE_FIELDS.map((field) => (side as Rates)?.[field] ?? null),
		),
	);
}

/** The five-field fingerprint holds recorded before every rate was compared.
 *  Matching it keeps an upgrade from restarting every hold's clock. */
function legacyPricingFingerprint(model: PricedSides): string {
	const fields = [
		"inputPerMillion",
		"outputPerMillion",
		"cacheReadPerMillion",
		"cacheWritePerMillion",
		"cacheWrite1hPerMillion",
	];
	return JSON.stringify(
		[model.pricing, model.originPricing].map((side) => fields.map((field) => (side as Rates)?.[field] ?? null)),
	);
}

/** True when the fresh row's pricing is kosha's own cited schedule for that model. */
export function isCuratedSchedule(row: DiscoverySnapshotV1["models"][number]): boolean {
	if (!row.pricing?.schedule) return false;
	const match = SCHEDULED_PRICES.find((s) => s.providerId === row.providerId && s.modelId === row.modelId);
	return (
		match !== undefined &&
		row.pricing.inputPerMillion === match.peak.inputPerMillion &&
		row.pricing.outputPerMillion === match.peak.outputPerMillion
	);
}

/**
 * The pricing fields on a fresh row that hold exactly what kosha's cited
 * table gives for that model now. Recomputed from the table, never read
 * from a marker in the row: a snapshot or a local file can carry
 * `citation`, and that proves nothing.
 */
export function citedFieldsMatching(row: DiscoverySnapshotV1["models"][number], now: number): string[] {
	const entry = citedPriceFor(row.providerId, row.modelId);
	if (!entry || !row.pricing) return [];
	const expected = citedPricing(row.pricing, entry, now) as unknown as Record<string, unknown> | undefined;
	if (!expected) return [];
	const actual = row.pricing as unknown as Record<string, unknown>;
	return citedFields(entry).filter((field) => JSON.stringify(actual[field]) === JSON.stringify(expected[field]));
}

/** `target` with `fields` of its pricing taken from `source` (removed where `source` lacks them). */
function withFields<T extends PricedSides>(target: T, source: PricedSides, fields: readonly string[]): T {
	const pricing: Record<string, unknown> = { ...((target.pricing as Record<string, unknown> | null) ?? {}) };
	const from = (source.pricing as Record<string, unknown> | null) ?? {};
	for (const field of fields) {
		if (from[field] === undefined) delete pricing[field];
		else pricing[field] = from[field];
	}
	return { ...target, pricing } as T;
}

/** Restore a secondary billed rate that went from a price to 0. Cited fields are left alone. */
export function keepReportedSecondaryRates<T extends PricedSides>(
	previous: PricedSides,
	fresh: T,
	cited: readonly string[] = [],
): T {
	const a = previous.pricing as Rates;
	const b = fresh.pricing as Rates;
	if (!a || !b) return fresh;
	let pricing: Record<string, unknown> | null = null;
	for (const field of QUARANTINE_FIELDS) {
		if (HEADLINE_FIELDS.has(field) || cited.includes(field)) continue;
		const prev = a[field];
		if (typeof prev === "number" && prev > 0 && b[field] === 0) {
			pricing ??= { ...b };
			pricing[field] = prev;
		}
	}
	return pricing ? { ...fresh, pricing } : fresh;
}

/** True if a billed rate fell to zero (input or output) or to under 1% of the
 *  rate it replaces (any field). */
function billedRateCollapsed(previous: PricedSides, fresh: PricedSides): boolean {
	const a = previous.pricing as Rates;
	const b = fresh.pricing as Rates;
	if (!a || !b) return false;
	return QUARANTINE_FIELDS.some((field) => {
		const prev = a[field];
		const next = b[field];
		if (typeof prev !== "number" || typeof next !== "number" || prev <= 0) return false;
		if (next === 0) return HEADLINE_FIELDS.has(field);
		return next < prev * PRICING_COLLAPSE_RATIO;
	});
}

function liveAnchor(row: object, now: number): PriceAnchor | null {
	const anchor = (row as { priceAnchor?: PriceAnchor }).priceAnchor;
	if (!anchor || typeof anchor.at !== "number" || now - anchor.at > PRICE_ANCHOR_WINDOW_MS) return null;
	return anchor;
}

/** Raise the anchor to the accepted price where it's higher; reset it once
 *  the window has passed. Rows without headline rates carry no anchor. */
function withAnchor<T extends PricedSides>(row: T, anchor: PriceAnchor | null, now: number): T {
	const pricing = row.pricing as Rates;
	const next: PriceAnchor = { at: anchor?.at ?? now };
	let raised = anchor === null;
	for (const field of ["inputPerMillion", "outputPerMillion"] as const) {
		const accepted = pricing?.[field];
		const held = anchor?.[field];
		if (typeof accepted === "number" && accepted > 0 && (typeof held !== "number" || accepted > held)) {
			next[field] = accepted;
			raised = true;
		} else if (typeof held === "number") {
			next[field] = held;
		}
	}
	if (next.inputPerMillion === undefined && next.outputPerMillion === undefined) return row;
	if (raised) next.at = now;
	return { ...row, priceAnchor: next };
}

/** True if a headline rate sits outside the anchor's band. */
function driftsFromAnchor(anchor: PriceAnchor, fresh: PricedSides): boolean {
	const b = fresh.pricing as Rates;
	return (["inputPerMillion", "outputPerMillion"] as const).some((field) => {
		const a = anchor[field];
		const next = b?.[field];
		if (typeof a !== "number" || a <= 0 || typeof next !== "number" || next <= 0) return false;
		return next < a * PRICE_ANCHOR_FLOOR || next > a * PRICE_ANCHOR_CEILING;
	});
}

/**
 * Whether a fresh price needs holding: a collapse, a drift outside the
 * anchor's band, or a step past the threshold. A step back up toward the
 * anchor is a correction, not a suspect publish, so it's taken at once:
 * otherwise a wrong low price, once in, would be protected by its own hold.
 */
function priceMoveSuspect(previous: PricedSides, fresh: PricedSides, anchor: PriceAnchor | null): boolean {
	if (pricingFingerprint(previous) === pricingFingerprint(fresh)) return false;
	if (billedRateCollapsed(previous, fresh)) return true;
	if (anchor && driftsFromAnchor(anchor, fresh)) return true;
	const steps = thresholdSteps(previous, fresh);
	if (steps.length === 0) return false;
	if (!anchor) return true;
	return !steps.every(
		(step) =>
			step.side === "pricing" &&
			HEADLINE_FIELDS.has(step.field) &&
			step.next > step.prev &&
			step.next <= (anchor[step.field as "inputPerMillion" | "outputPerMillion"] ?? 0),
	);
}

/** The rates that moved by the quarantine threshold or more (either direction). */
function thresholdSteps(
	previous: PricedSides,
	fresh: PricedSides,
): Array<{ side: "pricing" | "originPricing"; field: string; prev: number; next: number }> {
	const steps: Array<{ side: "pricing" | "originPricing"; field: string; prev: number; next: number }> = [];
	for (const side of ["pricing", "originPricing"] as const) {
		const a = (previous[side] as Rates) ?? null;
		const b = (fresh[side] as Rates) ?? null;
		if (!a || !b) continue;
		for (const field of QUARANTINE_FIELDS) {
			const prev = a[field];
			const next = b[field];
			if (typeof prev !== "number" || typeof next !== "number") continue;
			if (prev === 0 || next === 0) continue; // zero on either side is a "not reported" placeholder, not a price move
			if (prev === next) continue;
			if (Math.abs((next - prev) / prev) >= PRICING_QUARANTINE_THRESHOLD) steps.push({ side, field, prev, next });
		}
	}
	return steps;
}

/** Add a capability tag exactly once, preserving order. */
function tagCapability(existing: string[] | undefined, tag: string): string[] {
	if (!existing) return [tag];
	return existing.includes(tag) ? existing : [...existing, tag];
}

/** True if the entry carries defined input + output rates on EITHER the
 *  origin (direct provider) side OR the proxy (`pricing`) side — even zero
 *  (free-tier). Anything else is "pricing-degraded" for our purposes. */
function hasUsablePricing(entry: { pricing?: unknown; originPricing?: unknown } | undefined): boolean {
	if (!entry) return false;
	type SideRates = { inputPerMillion?: number; outputPerMillion?: number };
	const sideHasPricing = (side: unknown): boolean => {
		const r = side as SideRates | null | undefined;
		if (!r) return false;
		return r.inputPerMillion !== undefined && r.outputPerMillion !== undefined;
	};
	return sideHasPricing(entry.originPricing) || sideHasPricing(entry.pricing);
}
