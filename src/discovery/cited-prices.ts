/**
 * kosha-discovery — Prices read off the provider's own page.
 *
 * Community catalogs carry one cache-write rate, no long-prompt cache rates,
 * no dated changes, and a `0` that means "no write premium" on some rows and
 * "unknown" on others. These entries fix that for first-party rows. Each was
 * read by hand from the page it cites, on the date it carries, and its fields
 * replace whatever a catalog said for them. Other fields keep the catalog's.
 *
 * Only first-party providers (the model's maker serving it) are touched:
 * resellers set their own prices, so a cited rate never fans out to them.
 *
 * Adding an entry: read the page yourself (not through a summarising fetch
 * you haven't checked), put the URL in `source`, today in `checkedAt`. A
 * date with no stated time zone is midnight Pacific, which is how Google
 * and OpenAI bill.
 * @module
 */

import { pricingAsOf, syncWriteMirrors } from "../pricing-resolve.js";
import type { CacheWriteTier, ModelCard, ModelPricing, PricingBand, PricingChange } from "../types.js";

/** One cited price, for one or more model ids on one provider. */
export interface CitedPrice {
	providerId: string;
	modelIds: readonly string[];
	/** The fields this entry sets. Everything else stays as the catalog had it. */
	rates: Partial<ModelPricing>;
	/**
	 * When true, catalog cache fields this entry doesn't set are removed, so a
	 * catalog write rate can't sit beside a cited "no write premium".
	 */
	cacheComplete?: boolean;
	source: string;
	checkedAt: string;
}

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const GOOGLE = "https://aistudio.google.com/docs/pricing";
const XAI = "https://docs.x.ai/docs/models";
const MINIMAX = "https://platform.minimax.io/docs/guides/pricing";
const ZAI = "https://docs.z.ai/guides/overview/pricing";
const DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing";
const KIMI = "https://platform.kimi.ai/docs/guide/context-caching";
const ALIBABA = "https://www.alibabacloud.com/help/en/model-studio/qwen4-max";

const CHECKED = "2026-11-17";

const M5 = 300;
const H1 = 3600;
const M30 = 1800;
const H12 = 43_200;

function tiers(...pairs: Array<[number, number]>): CacheWriteTier[] {
	return pairs.map(([ttlSeconds, perMillion]) => ({ ttlSeconds, perMillion }));
}

/** Anthropic: 5m and 1h writes listed per model. */
function anthropic(
	modelIds: string[],
	input: number,
	write5m: number,
	write1h: number,
	read: number,
	output: number,
	extra: Partial<ModelPricing> = {},
): CitedPrice {
	return {
		providerId: "anthropic",
		modelIds,
		rates: {
			inputPerMillion: input,
			outputPerMillion: output,
			cacheReadPerMillion: read,
			cacheWrites: tiers([M5, write5m], [H1, write1h]),
			cacheWriteBilling: "premium",
			...extra,
		},
		cacheComplete: true,
		source: ANTHROPIC,
		checkedAt: CHECKED,
	};
}

/** OpenAI: 30m and 12h writes, and a band over 272K input tokens for the whole request. */
function openai(
	modelIds: string[],
	short: [input: number, read: number, write30m: number | null, write12h: number | null, output: number],
	long: [input: number, read: number, write30m: number | null, write12h: number | null, output: number],
	extra: Partial<ModelPricing> = {},
): CitedPrice {
	const writes = (w30: number | null, w12: number | null) =>
		w30 === null || w12 === null ? undefined : tiers([M30, w30], [H12, w12]);
	const shortWrites = writes(short[2], short[3]);
	const longWrites = writes(long[2], long[3]);
	const band: PricingBand = {
		aboveInputTokens: 272_000,
		inputPerMillion: long[0],
		outputPerMillion: long[4],
		cacheReadPerMillion: long[1],
		...(longWrites ? { cacheWrites: longWrites } : {}),
	};
	return {
		providerId: "openai",
		modelIds,
		rates: {
			inputPerMillion: short[0],
			outputPerMillion: short[4],
			cacheReadPerMillion: short[1],
			...(shortWrites ? { cacheWrites: shortWrites, cacheWriteBilling: "premium" as const } : {}),
			bands: [band],
			...extra,
		},
		// Older models list no write price: leave the catalog's alone there.
		cacheComplete: shortWrites !== undefined,
		source: OPENAI,
		checkedAt: CHECKED,
	};
}

/** Cache writes that bill as plain input: implicit caching with only a hit price listed. */
function asInput(input: number): Partial<ModelPricing> {
	return { cacheWritePerMillion: input, cacheWriteBilling: "as-input" };
}

function flat(
	providerId: string,
	modelIds: string[],
	source: string,
	input: number,
	read: number,
	output: number,
	extra: Partial<ModelPricing> = {},
	cacheComplete = true,
): CitedPrice {
	return {
		providerId,
		modelIds,
		rates: { inputPerMillion: input, outputPerMillion: output, cacheReadPerMillion: read, ...extra },
		cacheComplete,
		source,
		checkedAt: CHECKED,
	};
}

/** Google's dated prices carry no time zone: midnight Pacific. */
const GEMINI_4_DOUBLING = "2026-12-01T00:00:00-08:00";
const GEMINI_FLASH_DOUBLING = "2027-01-01T00:00:00-08:00";

function change(effectiveAt: string, rates: PricingChange["rates"], source: string): PricingChange {
	return { effectiveAt, rates, source };
}

export const CITED_PRICES: readonly CitedPrice[] = [
	// ── Anthropic ──────────────────────────────────────────────────────────
	anthropic(["claude-fable-5-2", "claude-mythos-5-2"], 8, 10, 16, 0.2, 40, {
		batchInputPerMillion: 4,
		batchOutputPerMillion: 20,
	}),
	anthropic(["claude-fable-5-1", "claude-mythos-5-1"], 10, 12.5, 20, 0.25, 50, {
		batchInputPerMillion: 5,
		batchOutputPerMillion: 25,
	}),
	anthropic(["claude-fable-5", "claude-mythos-5"], 10, 12.5, 20, 1, 50, {
		batchInputPerMillion: 5,
		batchOutputPerMillion: 25,
	}),
	anthropic(["claude-opus-5-5"], 4, 5, 8, 0.2, 20),
	anthropic(
		[
			"claude-opus-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-7-20260416",
			"claude-opus-4-6",
			"claude-opus-4-6-20260205",
			"claude-opus-4-5",
			"claude-opus-4-5-20251101",
		],
		5,
		6.25,
		10,
		0.5,
		25,
	),
	anthropic(["claude-sonnet-5-5"], 2, 2.5, 4, 0.1, 10),
	anthropic(["claude-sonnet-5"], 2, 2.5, 4, 0.2, 10),
	anthropic(["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929"], 3, 3.75, 6, 0.3, 15),
	// Haiku 5.5 is priced by prompt length; the prompt counts cache reads and writes.
	anthropic(["claude-haiku-5-5"], 0.1, 0.125, 0.2, 0.01, 0.5, {
		bands: [
			{
				aboveInputTokens: 100_000,
				inputPerMillion: 0.5,
				outputPerMillion: 2.5,
				cacheReadPerMillion: 0.05,
				cacheWrites: tiers([M5, 0.625], [H1, 1]),
			},
		],
	}),
	anthropic(["claude-haiku-4-5", "claude-haiku-4-5-20251001"], 1, 1.25, 2, 0.1, 5),

	// ── OpenAI (Standard tier) ─────────────────────────────────────────────
	openai(["gpt-6.2-astra", "gpt-6.2-astra-law"], [8, 0.4, 10, 20, 40], [16, 0.8, 20, 40, 60], {
		batchInputPerMillion: 4,
		batchOutputPerMillion: 20,
	}),
	openai(["gpt-6.2-sol"], [2, 0.1, 2.5, 5, 10], [4, 0.2, 5, 10, 15], {
		batchInputPerMillion: 1,
		batchOutputPerMillion: 5,
	}),
	openai(["gpt-6-astra"], [10, 1, 12.5, 25, 50], [20, 2, 25, 50, 75]),
	openai(["gpt-6.1-sol"], [2, 0.1, 2.5, 5, 10], [4, 0.2, 5, 10, 15]),
	openai(["gpt-6.1-terra"], [1, 0.05, 1.25, 2.5, 5], [2, 0.1, 2.5, 5, 7.5]),
	openai(["gpt-6-luna"], [0.1, 0.01, 0.125, 0.25, 0.5], [0.2, 0.02, 0.25, 0.5, 0.75]),
	openai(["gpt-6-sol"], [2, 0.2, 2.5, 5, 10], [4, 0.4, 5, 10, 15]),
	openai(["gpt-5.6-sol"], [4, 0.4, 5, 10, 20], [8, 0.8, 10, 20, 30]),
	openai(["gpt-5.6-terra"], [2, 0.2, 2.5, 5, 12], [4, 0.4, 5, 10, 18]),
	openai(["gpt-5.6-luna"], [0.2, 0.02, 0.25, 0.5, 1.2], [0.4, 0.04, 0.5, 1, 1.8]),
	openai(["gpt-5.5", "gpt-5.5-2026-04-23"], [5, 0.5, null, null, 30], [10, 1, null, null, 45]),
	openai(["gpt-5.4", "gpt-5.4-2026-03-05"], [2.5, 0.25, null, null, 15], [5, 0.5, null, null, 22.5]),

	// ── Google (Standard tier) ─────────────────────────────────────────────
	// Gemini 4 caches implicitly only, so a write is a cache miss billed as input.
	flat("google", ["gemini-4-carbon", "gemini-4-argon"], GOOGLE, 2, 0.1, 10, {
		...asInput(2),
		batchInputPerMillion: 1,
		batchOutputPerMillion: 5,
		changes: [
			change(
				GEMINI_4_DOUBLING,
				{
					inputPerMillion: 4,
					outputPerMillion: 20,
					cacheReadPerMillion: 0.2,
					cacheWritePerMillion: 4,
					batchInputPerMillion: 2,
					batchOutputPerMillion: 10,
				},
				GOOGLE,
			),
		],
	}),
	flat("google", ["gemini-4-hydrogen"], GOOGLE, 1.5, 0.075, 7.5, {
		...asInput(1.5),
		batchInputPerMillion: 0.75,
		batchOutputPerMillion: 3.75,
	}),
	// Explicit caching: the write bills as input, plus storage by the hour.
	flat("google", ["gemini-3.8-flash", "gemini-3.6-flash"], GOOGLE, 0.75, 0.075, 3.75, {
		...asInput(0.75),
		cacheStoragePerMillionPerHour: 0.5,
		batchInputPerMillion: 0.375,
		batchOutputPerMillion: 1.875,
		changes: [
			change(
				GEMINI_FLASH_DOUBLING,
				{
					inputPerMillion: 1.5,
					outputPerMillion: 7.5,
					cacheReadPerMillion: 0.15,
					cacheWritePerMillion: 1.5,
					cacheStoragePerMillionPerHour: 1,
					batchInputPerMillion: 0.75,
					batchOutputPerMillion: 3.75,
				},
				GOOGLE,
			),
		],
	}),
	flat("google", ["gemini-3.5-flash-lite"], GOOGLE, 0.3, 0.03, 2.5, {
		...asInput(0.3),
		cacheStoragePerMillionPerHour: 1,
	}),
	flat("google", ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview"], GOOGLE, 0.25, 0.025, 1.5, {
		...asInput(0.25),
		cacheStoragePerMillionPerHour: 1,
	}),
	flat("google", ["gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"], GOOGLE, 2, 0.2, 12, {
		...asInput(2),
		cacheStoragePerMillionPerHour: 4.5,
		bands: [{ aboveInputTokens: 200_000, inputPerMillion: 4, outputPerMillion: 18, cacheReadPerMillion: 0.4 }],
	}),

	// ── xAI: only a cached-input price; at 200K and up every token pays more ─
	...(
		[
			[["grok-4.7", "grok-4.6"], 2, 0.5, 6, 4, 1, 12],
			[["grok-4.5", "grok-4.5-latest"], 2, 0.3, 6, 4, 0.6, 12],
			[
				[
					"grok-4.3",
					"grok-4.3-latest",
					"grok-4.20-0309-reasoning",
					"grok-4.20-0309-non-reasoning",
					"grok-4.20-multi-agent-0309",
				],
				1.25,
				0.2,
				2.5,
				2.5,
				0.4,
				5,
			],
			[["grok-build-0.1", "grok-build-latest"], 1, 0.2, 2, 2, 0.4, 4],
		] as Array<[string[], number, number, number, number, number, number]>
	).map(([ids, input, read, output, longInput, longRead, longOutput]) =>
		flat("xai", ids, XAI, input, read, output, {
			...asInput(input),
			bands: [
				{
					aboveInputTokens: 200_000,
					inclusive: true,
					inputPerMillion: longInput,
					outputPerMillion: longOutput,
					cacheReadPerMillion: longRead,
				},
			],
		}),
	),

	// ── MiniMax: the page lists no write price, so the catalog's stands ────
	flat("minimax", ["MiniMax-M3.1-Flash"], MINIMAX, 0.15, 0.015, 0.6, {}, false),
	flat(
		"minimax",
		["MiniMax-M3"],
		MINIMAX,
		0.3,
		0.06,
		1.2,
		{ bands: [{ aboveInputTokens: 512_000, inputPerMillion: 0.6, outputPerMillion: 2.4, cacheReadPerMillion: 0.12 }] },
		false,
	),

	// ── z.ai: a cached-input price, storage "limited-time free", no write premium ─
	flat("zai", ["glm-5.3", "glm-5.2", "glm-5.1"], ZAI, 1.4, 0.26, 4.4, asInput(1.4)),
	flat("zai", ["glm-5"], ZAI, 1, 0.2, 3.2, asInput(1)),
	flat("zai", ["glm-4.7", "glm-4.6", "glm-4.5"], ZAI, 0.6, 0.11, 2.2, asInput(0.6)),
	flat("zai", ["glm-5.3-flash"], ZAI, 0.15, 0.03, 0.5, asInput(0.15)),
	flat("zai", ["glm-5.3-flashx", "glm-5.3-flashx-legal"], ZAI, 0.37, 0.075, 1.25, asInput(0.37)),
	flat("zai", ["glm-4.5-x"], ZAI, 2.2, 0.45, 8.9, asInput(2.2)),
	flat("zai", ["glm-4.5-air"], ZAI, 0.2, 0.03, 1.1, asInput(0.2)),
	flat("zai", ["glm-4.5-airx"], ZAI, 1.1, 0.22, 4.5, asInput(1.1)),

	// ── DeepSeek: hit and miss prices only; a write is a miss (peak rates; the
	//    off-peak half lives in price-schedules.ts) ────────────────────────
	flat("deepseek", ["deepseek-flash"], DEEPSEEK, 0.3, 0.006, 1.2, asInput(0.3)),
	flat("deepseek", ["deepseek-v4-pro"], DEEPSEEK, 1.32, 0.044, 3.96, asInput(1.32)),

	// ── Moonshot (international): K3 writes by TTL, and the 5m one costs input ─
	{
		providerId: "moonshot",
		modelIds: ["kimi-k3"],
		rates: {
			inputPerMillion: 3,
			cacheReadPerMillion: 0.3,
			cacheWrites: tiers([M5, 3], [H1, 6]),
			cacheWriteBilling: "premium",
		},
		cacheComplete: true,
		source: KIMI,
		checkedAt: CHECKED,
	},

	// ── Alibaba (Singapore): headline only; cache rates are "see console" ──
	{
		providerId: "alibaba",
		modelIds: ["qwen4-max"],
		rates: { inputPerMillion: 1.5, outputPerMillion: 4.5 },
		source: ALIBABA,
		checkedAt: CHECKED,
	},
];

/** A release date read off the provider's changelog, for models no catalog dates. */
export interface CitedRelease {
	providerId: string;
	modelIds: readonly string[];
	releaseDate: string;
	source: string;
}

const ANTHROPIC_NOTES = "https://platform.claude.com/docs/en/release-notes/overview";
const GOOGLE_CHANGELOG = "https://aistudio.google.com/docs/changelog";
const OPENAI_CHANGELOG = "https://developers.openai.com/api/docs/changelog";

/** Only filled where a catalog has no date. Checked 2026-11-17. */
export const CITED_RELEASES: readonly CitedRelease[] = [
	{ providerId: "anthropic", modelIds: ["claude-mythos-5-2"], releaseDate: "2026-11-09", source: ANTHROPIC_NOTES },
	{ providerId: "google", modelIds: ["gemini-decision-1"], releaseDate: "2026-11-11", source: GOOGLE_CHANGELOG },
	{ providerId: "google", modelIds: ["gemini-omni-1.2-flash"], releaseDate: "2026-11-05", source: GOOGLE_CHANGELOG },
	{
		providerId: "openai",
		modelIds: ["omni-moderation-csam-latest"],
		releaseDate: "2026-11-16",
		source: OPENAI_CHANGELOG,
	},
	{ providerId: "openai", modelIds: ["gpt-6-cyber"], releaseDate: "2026-11-05", source: OPENAI_CHANGELOG },
	{
		providerId: "openai",
		modelIds: ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"],
		releaseDate: "2026-11-04",
		source: OPENAI_CHANGELOG,
	},
];

const DEFAULT_RELEASE_INDEX = new Map<string, CitedRelease>(
	CITED_RELEASES.flatMap((entry) => entry.modelIds.map((id) => [`${entry.providerId}/${id}`, entry])),
);

function citedReleaseFor(providerId: string, modelId: string): CitedRelease | undefined {
	return DEFAULT_RELEASE_INDEX.get(`${providerId}/${modelId}`);
}

/** Pricing fields that describe caching. `cacheComplete` clears the ones an entry leaves out. */
const CACHE_FIELDS = [
	"cacheReadPerMillion",
	"cacheWritePerMillion",
	"cacheWrite1hPerMillion",
	"cacheWrites",
	"cacheWriteBilling",
	"cacheStoragePerMillionPerHour",
] as const;

/** Index by `provider/model` for O(1) lookup. */
function indexCited(entries: readonly CitedPrice[]): Map<string, CitedPrice> {
	const map = new Map<string, CitedPrice>();
	for (const entry of entries) for (const id of entry.modelIds) map.set(`${entry.providerId}/${id}`, entry);
	return map;
}

const DEFAULT_INDEX = indexCited(CITED_PRICES);

/** The cited entry for a provider's model, or undefined. */
export function citedPriceFor(
	providerId: string,
	modelId: string,
	entries: readonly CitedPrice[] = CITED_PRICES,
): CitedPrice | undefined {
	const index = entries === CITED_PRICES ? DEFAULT_INDEX : indexCited(entries);
	return index.get(`${providerId}/${modelId}`);
}

/**
 * The pricing a cited entry produces on top of `base`, as of `at`: the
 * entry's fields win, write mirrors follow `cacheWrites`, long-context
 * mirrors follow the first band, and changes already due are folded in.
 */
export function citedPricing(base: ModelPricing | undefined, entry: CitedPrice, at: number): ModelPricing | undefined {
	const merged: Record<string, unknown> = { ...(base ?? {}) };
	if (entry.cacheComplete) for (const field of CACHE_FIELDS) if (!(field in entry.rates)) delete merged[field];
	Object.assign(merged, entry.rates);
	if (entry.rates.bands) {
		// The legacy mirror is the first band; a catalog's stale one must not survive.
		const first = entry.rates.bands[0];
		merged.longContextThresholdTokens = first.aboveInputTokens;
		merged.longContextInputPerMillion = first.inputPerMillion;
		merged.longContextOutputPerMillion = first.outputPerMillion;
	}
	if (typeof merged.inputPerMillion !== "number" || typeof merged.outputPerMillion !== "number") return base;
	let pricing = syncWriteMirrors(merged as unknown as ModelPricing);
	pricing.citation = { source: entry.source, checkedAt: entry.checkedAt, fields: citedFields(entry) };
	pricing = pricingAsOf(pricing, at);
	const next = pricing.changes?.length
		? pricing.changes.map((c) => c.effectiveAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
		: undefined;
	if (next) pricing.pricingValidUntil = next;
	return pricing;
}

/** The pricing fields an entry sets, including the mirrors it implies. */
export function citedFields(entry: CitedPrice): string[] {
	const fields = new Set<string>(Object.keys(entry.rates));
	if (entry.rates.cacheWrites) {
		fields.add("cacheWritePerMillion");
		if (entry.rates.cacheWrites.some((tier) => tier.ttlSeconds === 3600)) fields.add("cacheWrite1hPerMillion");
	}
	if (entry.rates.bands) {
		fields.add("longContextThresholdTokens");
		fields.add("longContextInputPerMillion");
		fields.add("longContextOutputPerMillion");
	}
	return [...fields].sort();
}

/** Give every first-party card with a cited entry its cited rates (and a cited release date when it has none). Others are untouched. */
export function applyCitedPrices(
	cards: ModelCard[],
	now: Date = new Date(),
	entries: readonly CitedPrice[] = CITED_PRICES,
): ModelCard[] {
	const at = now.getTime();
	return cards.map((card) => {
		const release = card.releaseDate ? undefined : citedReleaseFor(card.provider, card.id);
		const dated = release ? { ...card, releaseDate: release.releaseDate } : card;
		const entry = citedPriceFor(card.provider, card.id, entries);
		if (!entry) return dated;
		const pricing = citedPricing(card.pricing, entry, at);
		return pricing && pricing !== card.pricing ? { ...dated, pricing } : dated;
	});
}

/** Fold due changes into every card that carries them (a cached registry read after the date). */
export function applyDueChanges(cards: ModelCard[], now: Date = new Date()): ModelCard[] {
	const at = now.getTime();
	return cards.map((card) => {
		if (!card.pricing?.changes?.length) return card;
		const pricing = pricingAsOf(card.pricing, at);
		return pricing === card.pricing ? card : { ...card, pricing };
	});
}
