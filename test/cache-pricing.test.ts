/**
 * Cited cache pricing: write tiers by lifetime, long-prompt bands, dated
 * changes, the catalog sanity rules, and how the quarantine treats a cited
 * price. Prices pinned here were read off each provider's page on 2026-11-17.
 */

import { describe, expect, it } from "vitest";
import { actualCostFromUsage } from "../src/cost.js";
import { applyCitedPrices, CITED_PRICES } from "../src/discovery/cited-prices.js";
import type { DiscoveryModelV1, DiscoverySnapshotV1 } from "../src/discovery-contract.js";
import { DISCOVERY_SCHEMA_VERSION } from "../src/discovery-contract.js";
import { newestModels } from "../src/newest.js";
import { sanitizeCacheRates, sanitizePricing } from "../src/price-trust.js";
import { pricingAsOf, resolvePricing } from "../src/pricing-resolve.js";
import { applyCuratedPricing, mergeManifests } from "../src/registry-runtime.js";
import { estimateUsdCost } from "../src/tally.js";
import type { ModelCard, ModelPricing } from "../src/types.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");

function card(provider: string, id: string, pricing?: ModelPricing, extra: Partial<ModelCard> = {}): ModelCard {
	return {
		id,
		name: id,
		provider,
		originProvider: provider,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		...(pricing ? { pricing } : {}),
		aliases: [],
		discoveredAt: NOW,
		source: "litellm",
		...extra,
	} as ModelCard;
}

function cited(provider: string, id: string, pricing?: ModelPricing, at = NOW): ModelPricing {
	const out = applyCitedPrices([card(provider, id, pricing)], new Date(at))[0].pricing;
	if (!out) throw new Error(`no pricing for ${provider}/${id}`);
	return out;
}

describe("cited prices: Anthropic", () => {
	const table: Array<[string, number, number, number, number, number]> = [
		["claude-fable-5-2", 8, 10, 16, 0.2, 40],
		["claude-mythos-5-2", 8, 10, 16, 0.2, 40],
		["claude-fable-5-1", 10, 12.5, 20, 0.25, 50],
		["claude-opus-5-5", 4, 5, 8, 0.2, 20],
		["claude-opus-5", 5, 6.25, 10, 0.5, 25],
		["claude-sonnet-5-5", 2, 2.5, 4, 0.1, 10],
		["claude-sonnet-5", 2, 2.5, 4, 0.2, 10],
		["claude-haiku-5-5", 0.1, 0.125, 0.2, 0.01, 0.5],
	];
	it.each(table)("%s matches the official table", (id, input, w5m, w1h, read, output) => {
		// The catalog's numbers are deliberately wrong: the cited table wins.
		const p = cited("anthropic", id, { inputPerMillion: 99, outputPerMillion: 99, cacheReadPerMillion: 9 });
		expect(p.inputPerMillion).toBe(input);
		expect(p.outputPerMillion).toBe(output);
		expect(p.cacheReadPerMillion).toBe(read);
		expect(p.cacheWritePerMillion).toBe(w5m);
		expect(p.cacheWrite1hPerMillion).toBe(w1h);
		expect(p.cacheWrites).toEqual([
			{ ttlSeconds: 300, perMillion: w5m },
			{ ttlSeconds: 3600, perMillion: w1h },
		]);
		expect(p.cacheWriteBilling).toBe("premium");
		expect(p.citation?.source).toBe("https://platform.claude.com/docs/en/about-claude/pricing");
	});

	it("prices Haiku 5.5 over 100K prompt tokens at the higher band, cache reads counted", () => {
		const model = card("anthropic", "claude-haiku-5-5", cited("anthropic", "claude-haiku-5-5"));
		// 60K uncached + 50K cache read = 110K prompt: over the line, whole request.
		const cost = actualCostFromUsage(
			model,
			{ input_tokens: 60_000, cache_read_input_tokens: 50_000, output_tokens: 1_000_000 },
			"anthropic",
			NOW,
		);
		expect(cost?.usd).toBeCloseTo(0.06 * 0.5 + 0.05 * 0.05 + 1 * 2.5, 9);
		const short = actualCostFromUsage(model, { input_tokens: 60_000, output_tokens: 1_000_000 }, "anthropic", NOW);
		expect(short?.usd).toBeCloseTo(0.06 * 0.1 + 1 * 0.5, 9);
	});

	it("does not touch a reseller's row of the same model", () => {
		const reseller = { inputPerMillion: 9, outputPerMillion: 45, cacheReadPerMillion: 0.9 };
		expect(applyCitedPrices([card("openrouter", "claude-opus-5-5", reseller)])[0].pricing).toEqual(reseller);
	});
});

describe("cited prices: OpenAI", () => {
	it("gpt-6.2-astra: 30m / 12h writes, and the whole request moves to the band over 272K", () => {
		const p = cited("openai", "gpt-6.2-astra");
		expect([p.inputPerMillion, p.cacheReadPerMillion, p.outputPerMillion]).toEqual([8, 0.4, 40]);
		expect(p.cacheWrites).toEqual([
			{ ttlSeconds: 1800, perMillion: 10 },
			{ ttlSeconds: 43_200, perMillion: 20 },
		]);
		expect(p.cacheWritePerMillion).toBe(10);
		expect(p.cacheWrite1hPerMillion).toBeUndefined(); // OpenAI sells no 1h lifetime
		expect(p.longContextThresholdTokens).toBe(272_000);

		const atLine = resolvePricing(p, { promptTokens: 272_000, at: NOW });
		expect(atLine.inputPerMillion).toBe(8);
		const over = resolvePricing(p, { promptTokens: 272_001, at: NOW });
		expect([over.inputPerMillion, over.cacheReadPerMillion, over.outputPerMillion]).toEqual([16, 0.8, 60]);
		expect(over.cacheWrites).toEqual([
			{ ttlSeconds: 1800, perMillion: 20 },
			{ ttlSeconds: 43_200, perMillion: 40 },
		]);
		expect(over.cacheWritePerMillion).toBe(20);
	});

	it("gpt-6.1-sol and gpt-6-luna match the page", () => {
		const sol = cited("openai", "gpt-6.1-sol");
		expect([sol.inputPerMillion, sol.cacheReadPerMillion, sol.cacheWritePerMillion, sol.outputPerMillion]).toEqual([
			2, 0.1, 2.5, 10,
		]);
		const luna = resolvePricing(cited("openai", "gpt-6-luna"), { promptTokens: 500_000, at: NOW });
		expect([luna.inputPerMillion, luna.cacheReadPerMillion, luna.outputPerMillion]).toEqual([0.2, 0.02, 0.75]);
	});

	it("an OpenAI model with no listed write keeps the catalog's write", () => {
		const p = cited("openai", "gpt-5.4", { inputPerMillion: 2.5, outputPerMillion: 15, cacheWritePerMillion: 3 });
		expect(p.cacheWritePerMillion).toBe(3);
		expect(p.cacheReadPerMillion).toBe(0.25);
	});
});

describe("cited prices: no write premium", () => {
	it("a DeepSeek write bills as input, never as the catalog's free 0", () => {
		const [model] = applyCuratedPricing([
			card("deepseek", "deepseek-flash", {
				inputPerMillion: 0.3,
				outputPerMillion: 1.2,
				cacheReadPerMillion: 0.006,
				cacheWritePerMillion: 0,
			}),
		]);
		expect(model.pricing?.cacheWritePerMillion).toBe(0.3);
		expect(model.pricing?.cacheWriteBilling).toBe("as-input");
		const peakAt = Date.parse("2026-11-17T08:00:00Z"); // DeepSeek peak window (06:00-10:00 UTC)
		const peakCost = estimateUsdCost(
			{ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
			model.pricing as ModelPricing,
			peakAt,
		);
		expect(peakCost.cacheWriteUsd).toBeCloseTo(0.3, 9);
		const offPeakCost = estimateUsdCost(
			{ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
			model.pricing as ModelPricing,
			NOW, // 12:00 UTC is off-peak (0.15/M input & as-input write)
		);
		expect(offPeakCost.cacheWriteUsd).toBeCloseTo(0.15, 9);
	});

	it("Kimi K3's 5m write costs the same as input and its 1h write double", () => {
		const p = cited("moonshot", "kimi-k3", { inputPerMillion: 3, outputPerMillion: 15 });
		expect(p.cacheWritePerMillion).toBe(3);
		expect(p.cacheWrite1hPerMillion).toBe(6);
		expect(p.outputPerMillion).toBe(15); // not cited: the catalog's stays
	});

	it("drops a catalog write rate beside a cited no-premium price", () => {
		const p = cited("zai", "glm-5.3", { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheWrite1hPerMillion: 9 });
		expect(p.cacheWrite1hPerMillion).toBeUndefined();
		expect(p.cacheWritePerMillion).toBe(1.4);
	});
});

describe("dated price changes", () => {
	const before = Date.parse("2026-11-30T23:59:59-08:00");
	const after = Date.parse("2026-12-01T00:00:00-08:00");

	it("Gemini 4 Carbon doubles on 2026-12-01 Pacific, not a second earlier", () => {
		const nov = cited("google", "gemini-4-carbon", undefined, before);
		expect([nov.inputPerMillion, nov.outputPerMillion, nov.cacheReadPerMillion]).toEqual([2, 10, 0.1]);
		expect(nov.pricingValidUntil).toBe("2026-12-01T00:00:00-08:00");
		const dec = cited("google", "gemini-4-carbon", undefined, after);
		expect([dec.inputPerMillion, dec.outputPerMillion, dec.cacheReadPerMillion]).toEqual([4, 20, 0.2]);
		expect([dec.batchInputPerMillion, dec.batchOutputPerMillion]).toEqual([2, 10]);
		expect(dec.changes).toBeUndefined();
		expect(dec.pricingValidUntil).toBeUndefined();
	});

	it("a snapshot baked in November bills December's price after the date", () => {
		const baked = cited("google", "gemini-4-carbon", undefined, before);
		expect(pricingAsOf(baked, after).inputPerMillion).toBe(4);
		// Folding again changes nothing: the change carries absolute rates.
		expect(pricingAsOf(pricingAsOf(baked, after), after).inputPerMillion).toBe(4);
		const model = card("google", "gemini-4-carbon", baked);
		const cost = actualCostFromUsage(model, { prompt_tokens: 1_000_000, completion_tokens: 0 }, "openai", after);
		expect(cost?.usd).toBeCloseTo(4, 9);
	});

	it("Gemini 3.8 Flash doubles on 2027-01-01, storage too", () => {
		const jan = cited("google", "gemini-3.8-flash", undefined, Date.parse("2027-01-01T08:00:00Z"));
		expect([jan.inputPerMillion, jan.cacheReadPerMillion, jan.cacheStoragePerMillionPerHour]).toEqual([1.5, 0.15, 1]);
	});
});

describe("catalog cache sanity", () => {
	it("drops the real OpenRouter Kimi K3 write (15.6x input) and keeps its read", () => {
		const row = { inputPerMillion: 0.192, outputPerMillion: 0.9, cacheReadPerMillion: 0.182, cacheWritePerMillion: 3 };
		const out = sanitizeCacheRates(row);
		expect(out.cacheWritePerMillion).toBeUndefined();
		expect(out.cacheReadPerMillion).toBe(0.182);
	});

	it("drops the real OpenRouter Gemini storage fee filed as a write", () => {
		const row = {
			inputPerMillion: 1.5,
			outputPerMillion: 7.5,
			cacheReadPerMillion: 0.075,
			cacheWritePerMillion: 0.0833333333333333,
		};
		expect(sanitizeCacheRates(row).cacheWritePerMillion).toBeUndefined();
	});

	it("treats a catalog write of 0 as unknown, and a read above input as junk", () => {
		const out = sanitizeCacheRates({
			inputPerMillion: 1,
			outputPerMillion: 2,
			cacheReadPerMillion: 1.5,
			cacheWritePerMillion: 0,
		});
		expect(out).not.toHaveProperty("cacheWritePerMillion");
		expect(out).not.toHaveProperty("cacheReadPerMillion");
	});

	it("keeps real rates: a read equal to input, Anthropic's 1.25x / 2x, a write equal to input", () => {
		const real = {
			inputPerMillion: 4,
			outputPerMillion: 20,
			cacheReadPerMillion: 4,
			cacheWritePerMillion: 5,
			cacheWrite1hPerMillion: 8,
		};
		expect(sanitizeCacheRates(real)).toBe(real);
		const flat = { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3 };
		expect(sanitizeCacheRates(flat)).toBe(flat);
	});

	it("never judges the cited table: every entry survives the full curated pass unchanged", () => {
		for (const entry of CITED_PRICES) {
			for (const id of entry.modelIds) {
				const base = { inputPerMillion: 1, outputPerMillion: 1 };
				const once = cited(entry.providerId, id, base);
				const [curated] = applyCuratedPricing([card(entry.providerId, id, base)], new Date(NOW));
				// Time-of-day schedules (DeepSeek off-peak) layer on after; they aren't a cache rule.
				const { schedule: _schedule, ...rates } = curated.pricing ?? ({} as ModelPricing);
				expect(rates, `${entry.providerId}/${id}`).toEqual(once);
			}
		}
	});

	it("drops a malformed band or write tier from untrusted pricing", () => {
		const out = sanitizePricing({
			inputPerMillion: 1,
			outputPerMillion: 2,
			cacheWrites: [
				{ ttlSeconds: 300, perMillion: -1 },
				{ ttlSeconds: 3600, perMillion: 2 },
			],
			bands: [{ aboveInputTokens: 200_000, inputPerMillion: Number.NaN, outputPerMillion: 4 }],
		});
		expect(out?.cacheWrites).toEqual([{ ttlSeconds: 3600, perMillion: 2 }]);
		expect(out?.bands).toBeUndefined();
	});
});

function row(key: string, pricing: ModelPricing | null, extra: Partial<DiscoveryModelV1> = {}): DiscoveryModelV1 {
	const [providerId, modelId] = key.split(":");
	return {
		key,
		modelId,
		name: modelId,
		providerId,
		canonicalProviderId: providerId,
		originProviderId: providerId,
		mode: "chat",
		capabilities: [],
		rawCapabilities: [],
		contextWindow: 1_000_000,
		maxOutputTokens: 64_000,
		pricing,
		dimensions: null,
		maxInputTokens: null,
		discoveredAt: 0,
		source: "test",
		aliases: [],
		region: null,
		projectId: null,
		runtimeFamily: null,
		tokenizerFamily: null,
		quantization: null,
		memoryFootprintBytes: null,
		computeTarget: null,
		supportsStructuredOutput: null,
		supportsStreaming: null,
		toolDialect: null,
		structuredOutputModes: [],
		supportsParallelToolCalls: null,
		status: null,
		deprecationDate: null,
		replacedBy: null,
		releaseDate: null,
		...extra,
	};
}

function snap(models: DiscoveryModelV1[], discoveredAt: number): DiscoverySnapshotV1 {
	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		discoveredAt,
		cursor: "",
		providers: [],
		models,
		roles: [],
		health: [],
		credentialPrompts: [],
	};
}

describe("quarantine and cited prices", () => {
	const dec = Date.parse("2026-12-01T09:00:00Z");
	const nov = Date.parse("2026-11-30T09:00:00Z");

	it("lets the cited Dec 1 doubling through on its day", () => {
		const prev = snap([row("google:gemini-4-carbon", cited("google", "gemini-4-carbon", undefined, nov))], nov);
		const fresh = snap([row("google:gemini-4-carbon", cited("google", "gemini-4-carbon", undefined, dec))], dec);
		const merged = mergeManifests(prev, fresh).models[0];
		expect(merged.pricing?.inputPerMillion).toBe(4);
		expect(merged.rawCapabilities).not.toContain("pricing_quarantined");
	});

	it("still holds the same doubling on a model kosha doesn't cite", () => {
		const prev = snap([row("google:gemini-x", { inputPerMillion: 2, outputPerMillion: 10 })], nov);
		const fresh = snap([row("google:gemini-x", { inputPerMillion: 4, outputPerMillion: 20 })], dec);
		const merged = mergeManifests(prev, fresh).models[0];
		expect(merged.pricing?.inputPerMillion).toBe(2);
		expect(merged.rawCapabilities).toContain("pricing_quarantined");
	});

	it("holds a cited model's price that isn't what the table says (a planted citation proves nothing)", () => {
		const real = cited("google", "gemini-4-carbon", undefined, nov);
		const planted = { ...real, inputPerMillion: 20, outputPerMillion: 100 };
		const prev = snap([row("google:gemini-4-carbon", real)], nov);
		const fresh = snap([row("google:gemini-4-carbon", planted)], nov + 3_600_000);
		const merged = mergeManifests(prev, fresh).models[0];
		expect(merged.pricing?.inputPerMillion).toBe(2);
		expect(merged.rawCapabilities).toContain("pricing_quarantined");
	});
});

describe("newest models", () => {
	const t = Date.parse("2026-11-17T20:00:00Z");

	it("one row per model on the maker's route, newest first, dated by another route when needed", () => {
		const models = [
			card("openai", "gpt-6.2-sol", undefined, { releaseDate: "2026-11-17" }),
			card("openrouter", "openai/gpt-6.2-sol", undefined, { originProvider: "openai", releaseDate: "2026-11-17" }),
			card("alibaba", "qwen4-max"),
			card("deepinfra", "Qwen/Qwen4-Max", undefined, { originProvider: "alibaba", releaseDate: "2026-11-16" }),
			card("google", "gemini-x", undefined, { firstSeenAt: Date.parse("2026-11-15T10:00:00Z") }),
			card("anthropic", "claude-old", undefined, { releaseDate: "2025-01-01" }),
		];
		const rows = newestModels(models, { now: t, days: 30 });
		expect(rows.map((r) => [r.model.provider, r.model.id, r.date, r.dateSource])).toEqual([
			["openai", "gpt-6.2-sol", "2026-11-17", "release"],
			["alibaba", "qwen4-max", "2026-11-16", "route"],
			["google", "gemini-x", "2026-11-15", "first-seen"],
		]);
		expect(rows[0].alsoOn).toEqual(["openrouter"]);
	});

	it("groups Bedrock's prefixed ids with the maker's", () => {
		const models = [
			card("anthropic", "claude-fable-5-2", undefined, { releaseDate: "2026-11-09" }),
			card("bedrock", "us.anthropic.claude-fable-5-2", undefined, {
				originProvider: "anthropic",
				releaseDate: "2026-11-09",
			}),
		];
		const rows = newestModels(models, { now: t });
		expect(rows).toHaveLength(1);
		expect(rows[0].model.provider).toBe("anthropic");
	});
});

describe("first sightings", () => {
	it("dates a model that arrives after an earlier manifest, and only that one", () => {
		const t0 = Date.parse("2026-11-10T00:00:00Z");
		const t1 = Date.parse("2026-11-17T00:00:00Z");
		const first = mergeManifests(null, snap([row("p:old", null)], t0));
		expect(first.models[0].firstSeenAt).toBeUndefined();
		const second = mergeManifests(first, snap([row("p:old", null), row("p:new", null)], t1));
		expect(second.models.find((m) => m.modelId === "old")?.firstSeenAt).toBeUndefined();
		expect(second.models.find((m) => m.modelId === "new")?.firstSeenAt).toBe(t1);
		const third = mergeManifests(second, snap([row("p:old", null), row("p:new", null)], t1 + 86_400_000));
		expect(third.models.find((m) => m.modelId === "new")?.firstSeenAt).toBe(t1);
	});
});

describe("maker route", () => {
	it("a reseller that tags itself as origin is not the maker", () => {
		const models = [
			card("fireworks", "kimi-k3", undefined, { originProvider: "fireworks", releaseDate: "2026-11-10" }),
			card("moonshot", "kimi-k3", undefined, { releaseDate: "2026-11-10" }),
		];
		const rows = newestModels(models, { now: Date.parse("2026-11-17T00:00:00Z") });
		expect(rows.map((r) => r.model.provider)).toEqual(["moonshot"]);
	});
});
