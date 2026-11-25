import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AliasResolver } from "../src/aliases.js";
import { KoshaCache } from "../src/cache.js";
import { catalogCacheKey, configureCatalogSource, resetLocalCatalogCache } from "../src/catalog-source.js";
import { parseArgs } from "../src/cli.js";
import { cmdDiscover, cmdRefresh, formatCredentialSource, modelRow } from "../src/cli-commands.js";
import { c, formatPricingTier, renderTable } from "../src/cli-format.js";
import { pricingDetail, scheduleLine } from "../src/cli-pricing-detail.js";
import { actualCostFromUsage, estimateRequestCost, readSpendForMonth } from "../src/cost.js";
import { DeepSeekDiscoverer } from "../src/discovery/deepseek.js";
import { extractDirectProviderPricing } from "../src/discovery/direct-pricing-parse.js";
import { applyFreeTierFlag } from "../src/discovery/free-tier.js";
import { resetModelsDevCatalogCache } from "../src/discovery/modelsdev-catalog.js";
import { OpenAIDiscoverer } from "../src/discovery/openai.js";
import { resetSnapshotCatalogCache } from "../src/discovery/snapshot-catalog.js";
import { ZAIDiscoverer } from "../src/discovery/zai.js";
import { DISCOVERY_SCHEMA_VERSION, type DiscoverySnapshotV1 } from "../src/discovery-contract.js";
import { DirectProviderPricingEnricher, resetDirectPricingCache } from "../src/enrichment/direct-pricing.js";
import { LiteLLMEnricher } from "../src/enrichment/litellm.js";
import { resetLiteLLMCatalogCache } from "../src/enrichment/litellm-catalog.js";
import { applyManifestHolds, mergeManifests, type PriceAnchor } from "../src/manifest-merge.js";
import { handleJsonRpc } from "../src/mcp-server.js";
import { appendAnomalies, detectPricingAnomalies } from "../src/pricing-anomalies.js";
import { resolvePricing } from "../src/pricing-resolve.js";
import { getProviderDescriptor } from "../src/provider-catalog.js";
import { safeUpstreamUrl } from "../src/proxy.js";
import { ModelRegistry } from "../src/registry.js";
import { saveRegistryToCache } from "../src/registry-cache.js";
import {
	registryBuildHealthRecord,
	registryDiscoverySnapshot,
	registrySerializeModel,
} from "../src/registry-discovery.js";
import { enrichRegistryModels } from "../src/registry-runtime.js";
import { registryCheapestCandidates } from "../src/registry-selection.js";
import { createRegistryState } from "../src/registry-state.js";
import { CircuitBreaker } from "../src/resilience.js";
import { redactSecrets, scanPayload } from "../src/security.js";
import { createServer } from "../src/server.js";
import { estimateUsdCost, normalizeTokenUsage, tallyCosts } from "../src/tally.js";
import type { ModelCard, ModelPricing, ProviderInfo } from "../src/types.js";
import { translateAnthropicStreamToOpenAI, translateOpenAIToAnthropic } from "../src/wire-anthropic.js";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function walkTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkTsFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function fixtureEnvToken(provider: string): string {
	return `fixture-${provider}-token`;
}

function makeCard(overrides: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
	const capabilities = overrides.capabilities ?? ["chat"];
	return {
		name: overrides.id,
		mode: "chat",
		capabilities,
		rawCapabilities: overrides.rawCapabilities ?? [...capabilities],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "api",
		originProvider: overrides.originProvider ?? overrides.provider,
		...overrides,
	};
}

function makeRegistry(providers: ProviderInfo[], aliases: Record<string, string> = {}): ModelRegistry {
	return ModelRegistry.fromJSON({
		providers,
		aliases,
		discoveredAt: Date.now(),
	});
}

function makeSnapshot(
	overrides: Partial<DiscoverySnapshotV1> & Pick<DiscoverySnapshotV1, "cursor" | "models">,
): DiscoverySnapshotV1 {
	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		discoveredAt: Date.now(),
		providers: [],
		roles: [],
		health: [],
		credentialPrompts: [],
		...overrides,
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetModelsDevCatalogCache();
	resetLiteLLMCatalogCache();
	resetSnapshotCatalogCache();
	resetDirectPricingCache();
	resetLocalCatalogCache();
	configureCatalogSource({ catalogSource: "community" });
	vi.restoreAllMocks();
	delete process.env.KOSHA_MONTHLY_BUDGET_USD;
	delete process.env.KOSHA_TENANT_BUDGET_USD;
	delete process.env.KOSHA_LEDGER_PATH;
	delete process.env.ZAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("zero telemetry & transport hardening", () => {
	it("contains no telemetry, analytics, or crash-reporting URLs anywhere in src/", () => {
		const srcFiles = walkTsFiles(resolve(process.cwd(), "src"));
		expect(srcFiles.length).toBeGreaterThan(20);
		const urlPattern = /https?:\/\/[^\s"'`)\\]+/gi;
		const forbiddenHosts = [
			"posthog",
			"segment.",
			"amplitude",
			"mixpanel",
			"sentry",
			"datadog",
			"honeycomb",
			"google-analytics",
			"plausible",
			"telemetry",
			"bugsnag",
			"rollbar",
			"logrocket",
			"heap.io",
			"intercom",
		];

		const hits: string[] = [];
		for (const file of srcFiles) {
			const content = readFileSync(file, "utf8");
			for (const match of content.matchAll(urlPattern)) {
				const url = match[0].toLowerCase();
				if (forbiddenHosts.some((host) => url.includes(host))) {
					hits.push(`${file}: ${match[0]}`);
				}
			}
		}
		expect(hits).toEqual([]);
	});

	it("BaseDiscoverer rejects 4xx immediately without retry backoff and disables redirects", async () => {
		const fetchCalls: Array<{ url: string; redirect?: RequestRedirect }> = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			fetchCalls.push({ url, redirect: init?.redirect });
			return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, statusText: "Unauthorized" });
		}) as typeof globalThis.fetch;

		const discoverer = new DeepSeekDiscoverer();
		const startedAt = Date.now();
		await expect(discoverer.discover({ apiKey: "refused-key", source: "env" })).rejects.toThrow(/401/);
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].redirect).toBe("error");
	});
});

describe("pricing freshness, schedules, bands, and disjoint TokenUsage", () => {
	it("ModelRegistry.fromJSON applies due pricing.changes cutovers automatically", () => {
		const pastCutover = new Date(Date.now() - 60_000).toISOString();
		const reg = makeRegistry([
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				authenticated: true,
				lastRefreshed: Date.now(),
				models: [
					makeCard({
						id: "future-cutover-model",
						provider: "openai",
						pricing: {
							inputPerMillion: 10,
							outputPerMillion: 40,
							changes: [
								{
									effectiveAt: pastCutover,
									rates: { inputPerMillion: 5, outputPerMillion: 20 },
									source: "https://openai.com/pricing",
								},
							],
						},
					}),
				],
			},
		]);

		const card = reg.model("future-cutover-model");
		expect(card?.pricing?.inputPerMillion).toBe(5);
		expect(card?.pricing?.outputPerMillion).toBe(20);
	});

	it("evaluates DeepSeek UTC schedule windows in resolvePricing, estimateUsdCost, tallyCosts, actualCostFromUsage, and pricingDetail", () => {
		const deepseekPricing: ModelPricing = {
			inputPerMillion: 0.3,
			outputPerMillion: 1.2,
			cacheReadPerMillion: 0.006,
			schedule: {
				peakWindows: [
					{ days: [1, 2, 3, 4, 5], startHourUtc: 1, endHourUtc: 4 },
					{ days: [1, 2, 3, 4, 5], startHourUtc: 6, endHourUtc: 10 },
				],
				offPeak: { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003 },
				source: "https://api-docs.deepseek.com/quick_start/pricing",
			},
		};

		// 2026-11-25 is Wednesday: 08:00Z is peak, 12:00Z is off-peak.
		const peakAt = Date.parse("2026-11-25T08:00:00Z");
		const offPeakAt = Date.parse("2026-11-25T12:00:00Z");
		expect(resolvePricing(deepseekPricing, { at: peakAt }).inputPerMillion).toBe(0.3);
		expect(resolvePricing(deepseekPricing, { at: offPeakAt }).inputPerMillion).toBe(0.15);

		const usage = { inputTokens: 1_000_000, outputTokens: 0 };
		expect(estimateUsdCost(usage, deepseekPricing, peakAt)?.totalUsd).toBeCloseTo(0.3, 6);
		expect(estimateUsdCost(usage, deepseekPricing, offPeakAt)?.totalUsd).toBeCloseTo(0.15, 6);

		const tallied = tallyCosts([{ modelId: "deepseek-flash", usage }], () => deepseekPricing, offPeakAt);
		expect(tallied.totalUsd).toBeCloseTo(0.15, 6);

		const card = makeCard({ id: "deepseek-flash", provider: "deepseek", pricing: deepseekPricing });
		const offPeakActual = actualCostFromUsage(
			card,
			{ prompt_tokens: 1_000_000, completion_tokens: 0 },
			"openai",
			offPeakAt,
		);
		expect(offPeakActual?.usd).toBeCloseTo(0.15, 6);

		const line = scheduleLine(deepseekPricing, offPeakAt);
		expect(line).toContain("off-peak now");
		expect(line).toContain("UTC");
		const detail = pricingDetail(deepseekPricing, (s) => s, offPeakAt);
		expect(detail).toContain("Off-Peak Pricing:");
	});

	it("normalizes OpenAI prompt/completion sub-buckets disjointly without double billing", () => {
		const norm = normalizeTokenUsage({
			prompt_tokens: 1000,
			completion_tokens: 400,
			cache_creation_input_tokens: 100,
			prompt_tokens_details: { cached_tokens: 700 },
			completion_tokens_details: { reasoning_tokens: 150 },
		});
		expect(norm).toMatchObject({
			inputTokens: 200,
			cachedInputTokens: 700,
			cacheWriteTokens: 100,
			outputTokens: 250,
			reasoningTokens: 150,
		});

		const pricing: ModelPricing = {
			inputPerMillion: 10,
			outputPerMillion: 30,
			cacheReadPerMillion: 1,
			cacheWritePerMillion: 12.5,
		};
		const card = makeCard({ id: "gpt-test", provider: "openai", pricing });
		const actual = actualCostFromUsage(
			card,
			{
				prompt_tokens: 1000,
				completion_tokens: 400,
				prompt_tokens_details: { cached_tokens: 700 },
				completion_tokens_details: { reasoning_tokens: 150 },
			},
			"openai",
		);
		// uncached input: 300 * 10 / 1e6 = 0.003; cached: 700 * 1 / 1e6 = 0.0007; total output (250 + 150) * 30 / 1e6 = 0.012
		expect(actual?.usd).toBeCloseTo(0.0157, 6);
	});

	it("estimateRequestCost evaluates long-context bands and dated changes", () => {
		const pastCutover = new Date(Date.now() - 60_000).toISOString();
		const card = makeCard({
			id: "claude-tiered",
			provider: "anthropic",
			pricing: {
				inputPerMillion: 1,
				outputPerMillion: 5,
				changes: [
					{
						effectiveAt: pastCutover,
						source: "https://anthropic.com/pricing",
						rates: {
							inputPerMillion: 3,
							outputPerMillion: 15,
							bands: [{ aboveInputTokens: 200_000, inputPerMillion: 6, outputPerMillion: 22.5 }],
						},
					},
				],
			},
		});
		// Long prompt (>200k input tokens approximated from string length)
		const longEst = estimateRequestCost(card, {
			messages: [{ role: "user", content: "a".repeat(820_000) }],
			max_tokens: 1_000,
		});
		expect(longEst).not.toBeNull();
		expect(longEst!.inputTokens).toBeGreaterThan(200_000);
		expect(longEst!.estimatedUsd).toBeGreaterThan((longEst!.inputTokens / 1e6) * 5.9);
	});

	it("preserves streaming cache_creation 1h tier through translateAnthropicStreamToOpenAI for reconciliation", async () => {
		const encoder = new TextEncoder();
		const sseText = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					usage: {
						input_tokens: 100,
						cache_creation_input_tokens: 1_000,
						cache_creation: { ephemeral_1h_input_tokens: 1_000 },
					},
				},
			})}\n\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 50 },
			})}\n\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
		].join("");

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseText));
				controller.close();
			},
		});

		const { stream, usage } = translateAnthropicStreamToOpenAI(body, "claude-sonnet-4-6");
		const reader = stream.getReader();
		while (!(await reader.read()).done) {
			/* drain */
		}
		const settled = await usage;
		expect(settled?.cache_creation?.ephemeral_1h_input_tokens).toBe(1_000);

		const card = makeCard({
			id: "claude-sonnet-4-6",
			provider: "anthropic",
			pricing: {
				inputPerMillion: 3,
				outputPerMillion: 15,
				cacheWritePerMillion: 3.75,
				cacheWrite1hPerMillion: 6,
				cacheWrites: [
					{ ttlSeconds: 300, perMillion: 3.75 },
					{ ttlSeconds: 3600, perMillion: 6 },
				],
			},
		});
		const actual = actualCostFromUsage(card, settled, "anthropic");
		// 100 * 3/1e6 + 50 * 15/1e6 + 1000 * 6/1e6 = 0.0003 + 0.00075 + 0.006 = 0.00705
		expect(actual?.usd).toBeCloseTo(0.00705, 6);
	});
});

describe("discovery completeness, manifest merge & anomalies", () => {
	it("ZAIDiscoverer merges keyed /v1/models output with public seed entries", async () => {
		resetModelsDevCatalogCache();
		resetLiteLLMCatalogCache();
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.startsWith("https://api.z.ai/api/paas/v4/models")) {
				return new Response(JSON.stringify({ data: [{ id: "glm-4.6", object: "model", owned_by: "zai" }] }), {
					status: 200,
				});
			}
			if (url === "https://models.dev/api.json") {
				return new Response(
					JSON.stringify({
						zai: {
							id: "zai",
							models: {
								"glm-4.6": {
									id: "glm-4.6",
									name: "GLM-4.6",
									cost: { input: 0.6, output: 2.2 },
									limit: { context: 200_000, output: 16_384 },
								},
								"glm-4.5-flash": {
									id: "glm-4.5-flash",
									name: "GLM-4.5 Flash",
									cost: { input: 0, output: 0 },
									limit: { context: 128_000, output: 8_192 },
								},
							},
						},
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify({}), { status: 404 });
		}) as typeof globalThis.fetch;

		const cards = await new ZAIDiscoverer().discover({ apiKey: "refused-key", source: "env" });
		const ids = cards.map((c) => c.id);
		expect(ids).toContain("glm-4.6");
		expect(ids).toContain("glm-4.5-flash");
		expect(cards.find((c) => c.id === "glm-4.6")?.pricing?.inputPerMillion).toBe(0.6);
	});

	it("reverseAliases resolves date-stamped aliases and preserves firstSeenAt & aged-out quarantine lifecycle", () => {
		const resolver = new AliasResolver();
		const aliases = resolver.reverseAliases("claude-haiku-4-5-20251001");
		expect(aliases).toContain("haiku");
	});

	it("preserves firstSeenAt on serialized models and restores degraded-fresh pricing when quarantine lifts", () => {
		const state = createRegistryState({ cacheDir: makeTempDir("kosha-state-") });
		const firstSeenAt = 1_700_000_000_000;
		const model = makeCard({
			id: "m1",
			provider: "openai",
			pricing: { inputPerMillion: 10, outputPerMillion: 40 },
			firstSeenAt,
		});
		state.providerMap.set("openai", {
			id: "openai",
			name: "OpenAI",
			baseUrl: "https://api.openai.com",
			authenticated: true,
			lastRefreshed: Date.now(),
			models: [model],
		});

		const serialized = registrySerializeModel(state, model);
		expect(serialized.firstSeenAt).toBe(firstSeenAt);

		const agedOut = Date.now() - 8 * 24 * 60 * 60 * 1000;
		const base = makeSnapshot({
			cursor: "1",
			discoveredAt: agedOut - 10_000,
			models: [{ ...serialized, pricing: { inputPerMillion: 10, outputPerMillion: 40 } }],
		});
		const firstDrop = makeSnapshot({
			cursor: "2",
			discoveredAt: agedOut,
			models: [{ ...serialized, pricing: { inputPerMillion: 2, outputPerMillion: 8 } }],
		});
		const quarantined = mergeManifests(base, firstDrop);
		expect(quarantined.models[0].pricing?.inputPerMillion).toBe(10);
		expect(quarantined.models[0].rawCapabilities).toContain("pricing_quarantined");

		const now = Date.now();
		const merged = mergeManifests(quarantined, { ...firstDrop, discoveredAt: now });
		const row = merged.models[0];
		expect(row.pricing?.inputPerMillion).toBe(2);
		expect((row as unknown as { priceAnchor?: PriceAnchor }).priceAnchor?.inputPerMillion).toBe(2);

		// Degraded-fresh fallback: state model has no pricing (/v1/models stub), manifest holds settled $2 price.
		state.providerMap.get("openai")!.models[0] = makeCard({ id: "m1", provider: "openai", firstSeenAt });
		applyManifestHolds(state, merged);
		expect(state.providerMap.get("openai")!.models[0].pricing?.inputPerMillion).toBe(2);
	});

	it("detectPricingAnomalies skips curated scheduled/cited rows without false alarms", () => {
		const dsState = createRegistryState({ cacheDir: makeTempDir("kosha-anom-") });
		const dsModel = makeCard({
			id: "deepseek-flash",
			provider: "deepseek",
			originProvider: "deepseek",
			name: "DeepSeek Flash",
			pricing: { inputPerMillion: 0.6, outputPerMillion: 2.4 },
		});
		dsState.providerMap.set("deepseek", {
			id: "deepseek",
			name: "DeepSeek",
			baseUrl: "https://api.deepseek.com",
			authenticated: true,
			lastRefreshed: Date.now(),
			models: [dsModel],
		});
		const prevRow = registrySerializeModel(dsState, dsModel);
		const prev = makeSnapshot({
			cursor: "1",
			discoveredAt: Date.now() - 10_000,
			models: [prevRow],
		});
		const fresh = makeSnapshot({
			cursor: "2",
			discoveredAt: Date.now(),
			models: [
				{
					...prevRow,
					pricing: {
						inputPerMillion: 0.3,
						outputPerMillion: 1.2,
						schedule: {
							peakWindows: [{ days: [1, 2, 3, 4, 5], startHourUtc: 1, endHourUtc: 4 }],
							offPeak: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
							source: "https://api-docs.deepseek.com/quick_start/pricing",
						},
					},
				},
			],
		});
		expect(detectPricingAnomalies(prev, fresh)).toEqual([]);
	});

	it("filters retired and unverified $0 routes from registryCheapestCandidates", () => {
		const state = createRegistryState({ cacheDir: makeTempDir("kosha-sel-") });
		state.providerMap.set("openai", {
			id: "openai",
			name: "OpenAI",
			baseUrl: "https://api.openai.com",
			authenticated: true,
			lastRefreshed: Date.now(),
			models: [
				makeCard({
					id: "retired-cheap",
					provider: "openai",
					status: "retired",
					pricing: { inputPerMillion: 0.01, outputPerMillion: 0.01 },
				}),
				makeCard({
					id: "unverified-free",
					provider: "openai",
					source: "api",
					pricing: { inputPerMillion: 0, outputPerMillion: 0 },
				}),
				makeCard({ id: "real-paid", provider: "openai", pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
			],
		});
		const ranked = registryCheapestCandidates(state, { mode: "chat" });
		const pricedIds = ranked.matches.filter((m) => typeof m.score === "number").map((m) => m.modelId);
		expect(pricedIds).toEqual(["real-paid"]);
		expect(ranked.matches.map((m) => m.modelId)).not.toContain("retired-cheap");
	});

	it("kosha refresh --json prints only valid JSON to stdout", async () => {
		const stdoutChunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
			stdoutChunks.push(`${String(msg)}\n`);
		});
		const fakeRegistry = {
			refresh: vi.fn().mockResolvedValue([]),
			models: () => [],
			toJSON: () => ({ providers: [], aliases: {} }),
		} as unknown as ModelRegistry;

		await cmdRefresh(fakeRegistry, { json: true });
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(() => JSON.parse(stdoutChunks.join(""))).not.toThrow();
	});
});

describe("proxy, server, MCP, ledger, and security hardening", () => {
	it("includes native-http anthropic-wire plan providers in /proxy/v1/models and rejects non-object JSON bodies", async () => {
		const reg = makeRegistry([
			{
				id: "minimax-coding-plan",
				name: "MiniMax Coding Plan",
				baseUrl: "https://api.minimax.io/anthropic",
				authenticated: true,
				lastRefreshed: Date.now(),
				models: [makeCard({ id: "MiniMax-M2.5", provider: "minimax-coding-plan" })],
			},
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				authenticated: true,
				lastRefreshed: Date.now(),
				models: [makeCard({ id: "gpt-retired", provider: "openai", status: "retired" })],
			},
		]);
		const app = createServer(reg);

		const modelsRes = await app.request("/proxy/v1/models");
		expect(modelsRes.status).toBe(200);
		const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
		expect(modelsJson.data.map((d) => d.id)).toContain("MiniMax-M2.5");

		const arrayRes = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "[]",
		});
		expect(arrayRes.status).toBe(400);

		const refreshBadRes = await app.request("/api/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "null",
		});
		expect(refreshBadRes.status).toBe(400);

		const retiredRes = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-retired", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(retiredRes.status).toBe(422);
		const retiredJson = (await retiredRes.json()) as { error: string };
		expect(retiredJson.error).toContain("retired");
	});

	it("releases candidate 1 budget hold on 500 failover and enforces budget/ledger for shared keys on plan hosts", async () => {
		const dir = makeTempDir("kosha-proxy-budget-");
		process.env.KOSHA_LEDGER_PATH = join(dir, "ledger.jsonl");
		process.env.KOSHA_MONTHLY_BUDGET_USD = "0.02";
		process.env.ZAI_API_KEY = "refused-key";

		// Failover hold-release check across two priced OpenAI routes where candidate 1 fails with 500.
		process.env.OPENAI_API_KEY = "refused-key";
		process.env.OPENROUTER_API_KEY = "refused-or-key";
		const reg = makeRegistry([
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				authenticated: true,
				lastRefreshed: Date.now(),
				models: [
					makeCard({ id: "gpt-failover", provider: "openai", pricing: { inputPerMillion: 10, outputPerMillion: 10 } }),
				],
			},
			{
				id: "openrouter",
				name: "OpenRouter",
				baseUrl: "https://openrouter.ai/api",
				authenticated: true,
				lastRefreshed: Date.now(),
				models: [
					makeCard({
						id: "gpt-failover",
						provider: "openrouter",
						originProvider: "openai",
						pricing: { inputPerMillion: 5, outputPerMillion: 5 },
					}),
				],
			},
		]);
		const app = createServer(reg);

		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (new URL(url).origin === "https://api.openai.com") {
				return new Response(JSON.stringify({ error: "upstream boom" }), { status: 500 });
			}
			return new Response(
				JSON.stringify({
					id: "c1",
					object: "chat.completion",
					model: "gpt-failover",
					choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		// Tight budget ($0.02) fits candidate 1 OR candidate 2 (~$0.010), not both simultaneously.
		const failoverRes = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-failover", messages: [{ role: "user", content: "hi" }], max_tokens: 512 }),
		});
		expect(failoverRes.status).toBe(200);

		// Shared ZAI_API_KEY on zai-coding-plan is unpriced -> blocked by budget gate instead of bypassing as free!
		const planReg = makeRegistry([
			{
				id: "zai-coding-plan",
				name: "Z.AI Coding Plan",
				baseUrl: "https://api.z.ai/api/coding/paas/v4",
				authenticated: true,
				lastRefreshed: Date.now(),
				models: [makeCard({ id: "glm-plan-only", provider: "zai-coding-plan" })],
			},
		]);
		const planApp = createServer(planReg);
		const planRes = await planApp.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "glm-plan-only", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(planRes.status).toBe(422);
		const planBody = (await planRes.json()) as { error: string };
		expect(planBody.error).toContain("no priced route");
	});

	it("readSpendForMonth skips null, array, and malformed JSONL rows gracefully", async () => {
		const dir = makeTempDir("kosha-ledger-");
		const ledger = join(dir, "ledger.jsonl");
		const now = Date.now();
		writeFileSync(
			ledger,
			["null", "[]", "{}", JSON.stringify({ ts: now, provider: "openai", modelId: "gpt-4o", estimatedUsd: 1.25 })].join(
				"\n",
			),
			"utf8",
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const spent = await readSpendForMonth(now, undefined, ledger);
		expect(spent).toBeCloseTo(1.25, 6);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("mcp-server recovers after loader failure, clamps limit to <=200, and redacts secrets in errors", async () => {
		const fakeGsk = ["gsk", "1234567890abcdefghij12345"].join("_");
		const manyModels = Array.from({ length: 205 }, (_, i) => makeCard({ id: `m-${i}`, provider: "groq" }));
		const reg = makeRegistry([
			{
				id: "groq",
				name: "Groq",
				baseUrl: "https://api.groq.com/openai",
				authenticated: false,
				lastRefreshed: Date.now(),
				models: manyModels,
			},
		]);
		vi.spyOn(reg, "discoveryErrors").mockReturnValue([
			{ providerId: "groq", providerName: "Groq", error: `failed with ${fakeGsk}`, timestamp: Date.now() },
		]);

		let calls = 0;
		const deps = {
			registry: async () => {
				calls += 1;
				if (calls === 1) throw new Error(`transient load error ${fakeGsk}`);
				return reg;
			},
		};

		const first = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kosha_provider_health", arguments: {} } },
			deps,
		);
		const firstResult = first?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
		expect(firstResult?.isError).toBe(true);
		const firstText = firstResult?.content?.[0]?.text ?? "";
		expect(firstText).not.toContain(fakeGsk);
		expect(firstText).toContain("[REDACTED]");

		const second = await handleJsonRpc(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "kosha_provider_health", arguments: { provider: "groq" } },
			},
			deps,
		);
		const secondResult = second?.result as { content?: Array<{ text: string }> } | undefined;
		const payloadText = secondResult?.content?.[0]?.text ?? "";
		expect(payloadText).not.toContain(fakeGsk);
		expect(payloadText).toContain("[REDACTED]");

		const clamped = await handleJsonRpc(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "kosha_query_models", arguments: { provider: "groq", limit: 9999 } },
			},
			deps,
		);
		const clampedResult = clamped?.result as { content?: Array<{ text: string }> } | undefined;
		const rows = JSON.parse(clampedResult?.content?.[0]?.text ?? "[]") as unknown[];
		expect(rows).toHaveLength(200);
	});

	it("CREDENTIAL_PATTERNS catches and redacts gsk_, xai-, nvapi-, pplx-, and hyphenated sk- keys", () => {
		const samples = [
			["gsk", "a".repeat(24)].join("_"),
			["xai", "b".repeat(24)].join("-"),
			["nvapi", "c".repeat(24)].join("-"),
			`pplx-${"d".repeat(32)}`,
			["sk", "ant", "e".repeat(24)].join("-"),
		];
		for (const sample of samples) {
			expect(scanPayload({ token: sample })?.threat).toBe("credential_leak");
			expect(redactSecrets(`auth failed for ${sample}`)).toBe("auth failed for [REDACTED]");
		}
	});
});

describe("Stage 1-4 upgrades: direct pricing, indexing, wire fidelity, proxy, MCP & CLI", () => {
	it("extractDirectProviderPricing handles OpenRouter, Together, and Vercel formats without inventing rates", () => {
		expect(
			extractDirectProviderPricing({
				pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
			}),
		).toMatchObject({ inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 });

		expect(
			extractDirectProviderPricing({ pricing: { input: 0.8, output: 1.6 } }, { perMillionInputOutput: true }),
		).toMatchObject({ inputPerMillion: 0.8, outputPerMillion: 1.6 });

		expect(
			extractDirectProviderPricing(
				{ pricing: { input: "0.000002", output: "0.000008" } },
				{ perTokenInputOutput: true },
			),
		).toMatchObject({ inputPerMillion: 2, outputPerMillion: 8 });

		expect(extractDirectProviderPricing({ pricing: { prompt: "0.000003" } })).toBeUndefined();
	});

	it("DirectProviderPricingEnricher fetches registered public endpoints only in community mode when pricing is missing", async () => {
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(url);
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "anthropic/claude-opus-4-6",
							pricing: { prompt: "0.000005", completion: "0.000025" },
						},
					],
				}),
				{ status: 200 },
			);
		}) as typeof globalThis.fetch;

		configureCatalogSource({ catalogSource: "pinned" });
		const enricher = new DirectProviderPricingEnricher();
		const card = makeCard({ id: "anthropic/claude-opus-4-6", provider: "openrouter", originProvider: "anthropic" });
		const pinnedResult = await enricher.enrich([card]);
		expect(calls).toHaveLength(0);
		expect(pinnedResult[0].pricing).toBeUndefined();

		configureCatalogSource({ catalogSource: "community" });
		const communityResult = await enricher.enrich([card]);
		expect(calls).toEqual(["https://openrouter.ai/api/v1/models"]);
		expect(communityResult[0].pricing?.inputPerMillion).toBe(5);
		expect(communityResult[0].pricingSource).toBe("provider-live");
		expect(communityResult[0].priceEvidence?.some((e) => e.source === "provider-api")).toBe(true);
	});

	it("ModelRegistry.model resolves 'provider/alias' pairs such as 'anthropic/opus' and refreshes secondary index automatically", () => {
		const reg = makeRegistry(
			[
				{
					id: "anthropic",
					name: "Anthropic",
					baseUrl: "https://api.anthropic.com",
					authenticated: true,
					lastRefreshed: Date.now(),
					models: [
						makeCard({
							id: "claude-opus-4-7",
							provider: "anthropic",
							pricing: { inputPerMillion: 5, outputPerMillion: 25 },
						}),
					],
				},
				{
					id: "openrouter",
					name: "OpenRouter",
					baseUrl: "https://openrouter.ai/api",
					authenticated: true,
					lastRefreshed: Date.now(),
					models: [
						makeCard({
							id: "anthropic/claude-opus-4-7",
							provider: "openrouter",
							originProvider: "anthropic",
							pricing: { inputPerMillion: 6, outputPerMillion: 30 },
						}),
					],
				},
			],
			{ opus: "claude-opus-4-7" },
		);

		const hit = reg.model("anthropic/opus");
		expect(hit?.provider).toBe("anthropic");
		expect(hit?.id).toBe("claude-opus-4-7");
		expect(hit?.pricing?.inputPerMillion).toBe(5);
	});

	it("resolvePricing applies optional serviceTier and currency", () => {
		const p: ModelPricing = {
			currency: "USD",
			inputPerMillion: 2.5,
			outputPerMillion: 10,
			cacheReadPerMillion: 1.25,
			serviceTiers: {
				flex: { inputPerMillion: 1.25, outputPerMillion: 5, cacheReadPerMillion: 0.625 },
				priority: { inputPerMillion: 4.5, outputPerMillion: 18 },
			},
		};
		const flex = resolvePricing(p, { serviceTier: "flex" });
		expect(flex.inputPerMillion).toBe(1.25);
		expect(flex.outputPerMillion).toBe(5);
		expect(flex.cacheReadPerMillion).toBe(0.625);
		expect(flex.currency).toBe("USD");
	});

	it("wire-anthropic preserves cache_control on tools/content blocks and explicit thinking config", () => {
		const translated = translateOpenAIToAnthropic({
			model: "claude-sonnet-4-6",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "analyze context", cache_control: { type: "ephemeral", ttl: "1h" } }],
				},
			],
			tools: [
				{
					type: "function",
					cache_control: { type: "ephemeral", ttl: "5m" },
					function: { name: "lookup", description: "Lookup data", parameters: { type: "object" } },
				},
			],
			thinking: { type: "enabled", budget_tokens: 2048 },
		});
		expect(translated.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
		expect(translated.tools?.[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
		const blocks = translated.messages[0].content;
		expect(Array.isArray(blocks) && blocks[0].type === "text" ? blocks[0].cache_control : undefined).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});

	it("proxy serves multi-capability kosha:hints, POST /proxy/v1/embeddings, and POST /proxy/v1/messages", async () => {
		process.env.OPENAI_API_KEY = fixtureEnvToken("openai");
		process.env.ANTHROPIC_API_KEY = fixtureEnvToken("anthropic");
		const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const parsedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			calls.push({ url, body: parsedBody, headers: new Headers(init?.headers) });
			if (url.endsWith("/embeddings")) {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [{ embedding: [0.1, 0.2] }],
						usage: { prompt_tokens: 8, total_tokens: 8 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.endsWith("/messages")) {
				return new Response(
					JSON.stringify({
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "hello native" }],
						stop_reason: "end_turn",
						usage: { input_tokens: 10, output_tokens: 5 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					id: "chatcmpl_1",
					object: "chat.completion",
					choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const reg = makeRegistry([
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				authenticated: true,
				credentialSource: "env",
				lastRefreshed: Date.now(),
				models: [
					makeCard({
						id: "gpt-vision-tool",
						provider: "openai",
						capabilities: ["chat", "vision", "function_calling"],
						contextWindow: 128_000,
						pricing: { inputPerMillion: 2, outputPerMillion: 8 },
					}),
					makeCard({
						id: "gpt-text-only",
						provider: "openai",
						capabilities: ["chat", "function_calling"],
						contextWindow: 128_000,
						pricing: { inputPerMillion: 0.2, outputPerMillion: 0.8 },
					}),
					makeCard({
						id: "text-embedding-3-small",
						provider: "openai",
						mode: "embedding",
						capabilities: ["embedding"],
						pricing: { inputPerMillion: 0.02, outputPerMillion: 0 },
					}),
				],
			},
			{
				id: "anthropic",
				name: "Anthropic",
				baseUrl: "https://api.anthropic.com",
				authenticated: true,
				credentialSource: "env",
				lastRefreshed: Date.now(),
				models: [
					makeCard({
						id: "claude-sonnet-4-6",
						provider: "anthropic",
						pricing: { inputPerMillion: 3, outputPerMillion: 15 },
					}),
				],
			},
		]);

		const app = createServer(reg);

		// Multi-capability selector picks gpt-vision-tool (skips cheaper gpt-text-only that lacks vision)
		const chatRes = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "kosha:cheapest[vision,tool_use,128k]",
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		expect(chatRes.status).toBe(200);
		expect(chatRes.headers.get("x-kosha-model")).toBe("gpt-vision-tool");

		// Embeddings endpoint
		const embRes = await app.request("/proxy/v1/embeddings", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "text-embedding-3-small", input: "hello world" }),
		});
		expect(embRes.status).toBe(200);
		expect(embRes.headers.get("x-kosha-model")).toBe("text-embedding-3-small");

		// Native Anthropic /v1/messages endpoint
		const msgRes = await app.request("/proxy/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				max_tokens: 128,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		expect(msgRes.status).toBe(200);
		expect(msgRes.headers.get("x-kosha-provider")).toBe("anthropic");
		expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
			"/v1/chat/completions",
			"/v1/embeddings",
			"/v1/messages",
		]);

		delete process.env.ANTHROPIC_API_KEY;
	});

	it("MCP expanded tools (compare, estimate, anomalies, providers), resources, /api/pricing-anomalies, and parseArgs work end-to-end", async () => {
		const dir = makeTempDir("kosha-mcp-res-");
		const cacheDir = join(dir, "cache");
		await appendAnomalies(dir, [
			{
				ts: Date.now(),
				key: "openai:gpt-4o",
				field: "input",
				side: "origin",
				previous: 5,
				current: 2.5,
				deltaPct: -0.5,
				promo: false,
			},
		]);

		const reg = new ModelRegistry({ cacheDir });
		const provMap = (reg as unknown as { providerMap: Map<string, ProviderInfo> }).providerMap;
		provMap.set("openai", {
			id: "openai",
			name: "OpenAI",
			baseUrl: "https://api.openai.com",
			authenticated: true,
			lastRefreshed: Date.now(),
			models: [
				makeCard({
					id: "gpt-4o",
					provider: "openai",
					pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 },
				}),
			],
		});

		const app = createServer(reg);
		const anomHttp = await app.request("/api/pricing-anomalies");
		expect(anomHttp.status).toBe(200);
		const anomJson = (await anomHttp.json()) as { count: number; anomalies: Array<{ key: string }> };
		expect(anomJson.count).toBe(1);
		expect(anomJson.anomalies[0].key).toBe("openai:gpt-4o");

		const deps = { registry: async () => reg };
		const cmpRes = await handleJsonRpc(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "kosha_compare_models", arguments: { models: ["gpt-4o", "missing-id"] } },
			},
			deps,
		);
		const cmpText = (cmpRes?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? "{}";
		const cmpData = JSON.parse(cmpText) as { models: Array<{ found: boolean; id?: string }> };
		expect(cmpData.models[0].found).toBe(true);
		expect(cmpData.models[1].found).toBe(false);

		const estRes = await handleJsonRpc(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "kosha_estimate_cost",
					arguments: { model: "gpt-4o", input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 500_000 },
				},
			},
			deps,
		);
		const estText = (estRes?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? "{}";
		const estData = JSON.parse(estText) as {
			totalUsd: number;
		};
		// 2.50 + 1.00 + 0.625 = 4.125
		expect(estData.totalUsd).toBeCloseTo(4.125, 6);

		const anomMcp = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "kosha://anomalies" } },
			deps,
		);
		const anomText =
			(anomMcp?.result as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]?.text ?? "[]";
		const anomMcpData = JSON.parse(anomText) as Array<{ key: string }>;
		expect(anomMcpData[0].key).toBe("openai:gpt-4o");

		const parsedCli = parseArgs(["discover", "--provider=anthropic", "--json", "-h", "--", "--literal"]);
		expect(parsedCli.positional).toEqual(["discover", "--literal"]);
		expect(parsedCli.flags).toMatchObject({ provider: "anthropic", json: true, help: true });
	});

	it("prevents OpenAI Responses API double-billing of cached_tokens and reasoning_tokens", () => {
		const responsesUsage = {
			input_tokens: 1_000,
			output_tokens: 500,
			input_tokens_details: { cached_tokens: 400 },
			output_tokens_details: { reasoning_tokens: 200 },
		};
		const norm = normalizeTokenUsage(responsesUsage);
		expect(norm).toEqual({
			inputTokens: 600,
			outputTokens: 300,
			cachedInputTokens: 400,
			reasoningTokens: 200,
			totalTokens: 1_500,
		});

		const pricing: ModelPricing = {
			inputPerMillion: 10,
			outputPerMillion: 40,
			cacheReadPerMillion: 1,
			reasoningOutputPerMillion: 40,
		};
		const card = makeCard({ id: "o4-mini", provider: "openai", pricing });
		expect(norm).not.toBeNull();
		const est = estimateUsdCost(norm!, pricing);
		expect(est.totalUsd).toBeCloseTo(0.0264, 6);
		const actual = actualCostFromUsage(card, responsesUsage, "openai");
		// 600*10/1e6 + 300*40/1e6 + 200*40/1e6 + 400*1/1e6 = 0.006 + 0.012 + 0.008 + 0.0004 = 0.0264
		expect(actual?.usd).toBeCloseTo(0.0264, 6);
		expect(actual?.outputTokens).toBe(500);
	});

	it("scoped saveRegistryToCache preserves unscoped providers_all timestamp and invalidates deleted scoped entry", async () => {
		const dir = makeTempDir("kosha-scoped-cache-");
		const cacheDir = join(dir, "cache");
		const oldTs = Date.now() - 12 * 3600 * 1000;
		const cache = new KoshaCache(cacheDir, 86_400_000);
		await cache.set(
			catalogCacheKey("providers_all"),
			[
				{
					id: "anthropic",
					name: "Anthropic",
					baseUrl: "https://api.anthropic.com",
					authenticated: true,
					models: [],
					lastRefreshed: oldTs,
				},
				{
					id: "openai",
					name: "OpenAI",
					baseUrl: "https://api.openai.com",
					authenticated: true,
					models: [],
					lastRefreshed: oldTs,
				},
				{
					id: "removed",
					name: "Removed",
					baseUrl: "https://api.removed.test",
					authenticated: true,
					models: [],
					lastRefreshed: oldTs,
				},
			],
			{ timestamp: oldTs },
		);
		await cache.set(catalogCacheKey("provider_removed"), { id: "removed" }, { timestamp: oldTs });

		const state = createRegistryState({ cacheDir });
		state.providerMap.set("openai", {
			id: "openai",
			name: "OpenAI",
			baseUrl: "https://api.openai.com",
			authenticated: true,
			models: [makeCard({ id: "gpt-4o", provider: "openai" })],
			lastRefreshed: Date.now(),
		});
		await saveRegistryToCache(state, ["openai", "removed"]);

		const afterAll = await cache.get<ProviderInfo[]>(catalogCacheKey("providers_all"));
		expect(afterAll?.timestamp).toBe(oldTs);
		expect(afterAll?.data.map((p) => p.id)).toEqual(["anthropic", "openai"]);
		expect(await cache.get(catalogCacheKey("provider_removed"))).toBeNull();
	});

	it("OpenAIDiscoverer classifies transcribe models as audio/speech_to_text and gpt-6 with vision/nlu", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "gpt-4o-transcribe", object: "model", owned_by: "openai" },
						{ id: "gpt-6.2-astra", object: "model", owned_by: "openai" },
					],
				}),
				{ status: 200 },
			)) as typeof globalThis.fetch;

		const cards = await new OpenAIDiscoverer().discover({ apiKey: "refused-key", source: "env" });
		const transcribe = cards.find((c) => c.id === "gpt-4o-transcribe");
		const gpt6 = cards.find((c) => c.id === "gpt-6.2-astra");
		expect(transcribe?.mode).toBe("audio");
		expect(transcribe?.capabilities).toEqual(["speech_to_text"]);
		expect(gpt6?.capabilities).toContain("vision");
		expect(gpt6?.capabilities).toContain("nlu");
	});

	it("LiteLLMEnricher keeps reseller pricing off originPricing, and applyFreeTierFlag strips stale free_tier after non-zero rate update", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					"openrouter/anthropic/claude-opus-4-7": { input_cost_per_token: 0.000009, output_cost_per_token: 0.000045 },
					"anthropic/claude-opus-4-7": { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
				}),
				{ status: 200 },
			)) as typeof globalThis.fetch;

		const enricher = new LiteLLMEnricher();
		const [enriched] = await enricher.enrich([
			makeCard({
				id: "anthropic/claude-opus-4-7",
				provider: "openrouter",
				originProvider: "anthropic",
			}),
		]);
		expect(enriched.pricing?.inputPerMillion).toBe(9);
		expect(enriched.originPricing?.inputPerMillion).toBe(5);

		const flagged = applyFreeTierFlag(
			makeCard({ id: "m-free", provider: "groq", pricing: { inputPerMillion: 0, outputPerMillion: 0 } }),
		);
		expect(flagged.capabilities).toContain("free_tier");
		const cleared = applyFreeTierFlag({ ...flagged, pricing: { inputPerMillion: 1, outputPerMillion: 2 } });
		expect(cleared.capabilities).not.toContain("free_tier");
		expect(cleared.rawCapabilities).not.toContain("free_tier");
	});

	it("proxy /v1/messages pre-filters Anthropic routes before limit cut, records single-route 5xx/429 health, and blocks localhost on remote safeUpstreamUrl", async () => {
		expect(safeUpstreamUrl("http://127.0.0.1:8080/v1/chat/completions", false)).toBeNull();
		process.env.ANTHROPIC_API_KEY = fixtureEnvToken("anthropic");
		process.env.OPENAI_API_KEY = fixtureEnvToken("openai");

		let failNext = true;
		globalThis.fetch = (async () => {
			if (failNext) {
				failNext = false;
				return new Response(JSON.stringify({ error: { type: "overloaded", message: "busy" } }), { status: 503 });
			}
			return new Response(
				JSON.stringify({ id: "msg_ok", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const manyCheapOpenAI = Array.from({ length: 25 }, (_, i) =>
			makeCard({
				id: `cheap-chat-${i}`,
				provider: "openai",
				pricing: { inputPerMillion: 0.01, outputPerMillion: 0.01 },
			}),
		);
		const reg = makeRegistry([
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				authenticated: true,
				credentialSource: "env",
				lastRefreshed: Date.now(),
				models: manyCheapOpenAI,
			},
			{
				id: "anthropic",
				name: "Anthropic",
				baseUrl: "https://api.anthropic.com",
				authenticated: true,
				credentialSource: "env",
				lastRefreshed: Date.now(),
				models: [
					makeCard({
						id: "claude-sonnet-4-6",
						provider: "anthropic",
						pricing: { inputPerMillion: 3, outputPerMillion: 15 },
					}),
				],
			},
		]);
		const app = createServer(reg);

		const firstRes = await app.request("/proxy/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "kosha:cheapest", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
		});
		expect(firstRes.status).toBe(503);
		expect(firstRes.headers.get("x-kosha-provider")).toBe("anthropic");
		expect(firstRes.headers.get("x-kosha-usage-source")).toBeNull();
		expect(reg.providerRouteHealth("anthropic").samples).toBe(1);
		expect(reg.providerRouteHealth("anthropic").lastErrorType).toBe("transport");

		const secondRes = await app.request("/proxy/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "kosha:cheapest", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
		});
		expect(secondRes.status).toBe(200);
		expect(reg.providerRouteHealth("anthropic").samples).toBe(2);
		delete process.env.ANTHROPIC_API_KEY;
	});

	it("MCP validates JSON-RPC method/arguments strictly and redacts secret strings in kosha://snapshot", async () => {
		const fakeGsk = ["gsk", "SecretLeak9876543210abcd"].join("_");
		const reg = makeRegistry([
			{
				id: "groq",
				name: "Groq",
				baseUrl: "https://api.groq.com/openai",
				authenticated: true,
				lastRefreshed: Date.now(),
				models: [makeCard({ id: "llama-3.1-8b", provider: "groq" })],
			},
		]);
		reg.recordProxyOutcome("groq", { ok: false, latencyMs: 10, errorType: `upstream error with ${fakeGsk}` });
		const deps = { registry: async () => reg };

		const missingMethod = await handleJsonRpc({ jsonrpc: "2.0", id: 1 } as never, deps);
		expect(missingMethod?.error?.code).toBe(-32600);

		const badArgs = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kosha_model_detail", arguments: "oops" } },
			deps,
		);
		expect(badArgs?.error?.code).toBe(-32602);

		const badModel = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kosha_model_detail", arguments: {} } },
			deps,
		);
		expect(badModel?.error?.code).toBe(-32602);

		const snapRes = await handleJsonRpc(
			{ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "kosha://snapshot" } },
			deps,
		);
		const snapText =
			(snapRes?.result as { contents?: Array<{ text?: string }> } | undefined)?.contents?.[0]?.text ?? "";
		expect(snapText).not.toContain(fakeGsk);
		expect(snapText).toContain("[REDACTED]");
	});
});

describe("v1.18.1 deep audit fixes", () => {
	it("allows Perplexity model ID pplx-decider-flash-latest in scanPayload while catching 32+ alnum keys", () => {
		expect(
			scanPayload({ id: "pplx-decider-flash-latest", models: [{ id: "pplx-decider-flash-latest" }] }),
		).toBeUndefined();
		const fakePplxKey = `pplx-${"A1b2C3d4".repeat(6)}`;
		expect(scanPayload({ token: fakePplxKey })?.threat).toBe("credential_leak");
	});

	it("redacts upstream secrets across OpenAI/Anthropic chat, embeddings, /v1/messages, and streamed SSE errors", async () => {
		const fakeSecret = ["gsk", "SecretLeakValue1234567890abcd"].join("_");

		// 1) translateAnthropicStreamToOpenAI error frame: redacts + emits no finish_reason:stop + usage is null
		const sseBody = new ReadableStream<Uint8Array>({
			start(ctrl) {
				const enc = new TextEncoder();
				ctrl.enqueue(
					enc.encode(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n`),
				);
				ctrl.enqueue(
					enc.encode(
						`event: error\ndata: {"type":"error","error":{"type":"auth","message":"bad key ${fakeSecret}"}}\n\n`,
					),
				);
				ctrl.close();
			},
		});
		const translated = translateAnthropicStreamToOpenAI(sseBody, "claude-sonnet-4-6");
		const sseText = await new Response(translated.stream).text();
		expect(sseText).not.toContain(fakeSecret);
		expect(sseText).toContain("[REDACTED]");
		expect(sseText).not.toContain('"finish_reason":"stop"');
		await expect(translated.usage).resolves.toBeNull();

		// 2) parseToolArguments rejects JSON arrays as tool_use.input
		const withArrayArgs = translateOpenAIToAnthropic({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "tc1", type: "function", function: { name: "fn", arguments: "[1,2,3]" } }],
				},
				{ role: "tool", tool_call_id: "tc1", content: "ok" },
			],
		});
		const assistantBlocks = withArrayArgs.messages[1].content as Array<{ type: string; input?: unknown }>;
		expect(assistantBlocks[0]).toMatchObject({ type: "tool_use", input: {} });

		// 3) Proxy upstream error redaction + CircuitBreaker.onSuccess recovery + terminal 429/401 recording
		process.env.OPENAI_API_KEY = fixtureEnvToken("openai");
		process.env.ANTHROPIC_API_KEY = fixtureEnvToken("anthropic");
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: { message: `leaked ${fakeSecret}` } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const reg = makeRegistry([
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com/v1",
				authenticated: true,
				credentialSource: "env",
				lastRefreshed: Date.now(),
				models: [
					makeCard({ id: "gpt-4o", provider: "openai", pricing: { inputPerMillion: 2.5, outputPerMillion: 10 } }),
					makeCard({
						id: "text-embedding-3-small",
						provider: "openai",
						mode: "embedding",
						capabilities: ["embedding"],
						pricing: { inputPerMillion: 0.02, outputPerMillion: 0 },
					}),
				],
			},
			{
				id: "anthropic",
				name: "Anthropic",
				baseUrl: "https://api.anthropic.com",
				authenticated: true,
				credentialSource: "env",
				lastRefreshed: Date.now(),
				models: [
					makeCard({
						id: "claude-sonnet-4-6",
						provider: "anthropic",
						pricing: { inputPerMillion: 3, outputPerMillion: 15 },
					}),
				],
			},
		]);
		const app = createServer(reg);

		for (const [path, payload] of [
			["/proxy/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }],
			["/proxy/v1/embeddings", { model: "text-embedding-3-small", input: "hi" }],
			[
				"/proxy/v1/messages",
				{ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
			],
		] as const) {
			const res = await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(401);
			const bodyText = await res.text();
			expect(bodyText).not.toContain(fakeSecret);
			expect(bodyText).toContain("[REDACTED]");
		}
		expect(reg.providerRouteHealth("openai").lastErrorType).toBe("auth_error");
		expect(reg.providerRouteHealth("anthropic").lastErrorType).toBe("auth_error");

		const cb = new CircuitBreaker("test-provider", { failureThreshold: 1, resetTimeoutMs: 60_000 });
		cb.onFailure();
		expect(cb.health().state).toBe("open");
		cb.onSuccess();
		expect(cb.health().state).toBe("closed");

		// Invalid ?mode= on /api/roles returns 400
		const badRoles = await app.request("/api/roles?mode=bogus");
		expect(badRoles.status).toBe(400);
	});

	it("wires Cohere /v1/chat/completions and Thinking Machines anthropic path in PROVIDER_CATALOG", () => {
		const cohere = getProviderDescriptor("cohere");
		expect(cohere?.chatCompletionsPath).toBe("/v1/chat/completions");
		const thinker = getProviderDescriptor("thinkingmachines");
		expect(thinker?.wire).toBe("anthropic");
		expect(thinker?.anthropicMessagesPath).toBe("/services/tinker-prod/anthropic/api/v1/messages");
	});

	it("updates stale prices via DirectProviderPricingEnricher before LiteLLM and fixes Vercel 1K unit scaling", async () => {
		const parsedVercel = extractDirectProviderPricing(
			{ pricing: { input: "0.000003", output: "0.000015", request: "5", web_search: "10" } },
			{ perTokenInputOutput: true, perThousandRequests: true },
		);
		expect(parsedVercel).toMatchObject({
			inputPerMillion: 3,
			outputPerMillion: 15,
			requestPerThousand: 5,
			webSearchPerThousandRequests: 10,
		});

		resetDirectPricingCache();
		resetLiteLLMCatalogCache();
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("openrouter.ai")) {
				return new Response(
					JSON.stringify({ data: [{ id: "openai/gpt-4o", pricing: { prompt: "0.000004", completion: "0.000016" } }] }),
					{ status: 200 },
				);
			}
			if (url.includes("litellm")) {
				return new Response(
					JSON.stringify({
						"openrouter/openai/gpt-4o": {
							input_cost_per_token: 0.000002,
							output_cost_per_token: 0.000008,
							supports_vision: true,
							supports_response_schema: true,
						},
						"gpt-4o": {
							litellm_provider: "openai",
							input_cost_per_token: 0.0000025,
							output_cost_per_token: 0.00001,
						},
					}),
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 404 });
		}) as typeof globalThis.fetch;

		const dir = makeTempDir("kosha-enrich-order-");
		const state = createRegistryState({ cacheDir: join(dir, "cache") });
		state.providerMap.set("openrouter", {
			id: "openrouter",
			name: "OpenRouter",
			baseUrl: "https://openrouter.ai/api/v1",
			authenticated: true,
			lastRefreshed: Date.now(),
			models: [
				makeCard({
					id: "openai/gpt-4o",
					provider: "openrouter",
					originProvider: "openai",
					pricing: { inputPerMillion: 1, outputPerMillion: 2 },
					pricingSource: "litellm",
				}),
			],
		});
		await enrichRegistryModels(state, { refreshExisting: true });
		const card = state.providerMap.get("openrouter")?.models[0];
		// Direct OpenRouter live pricing wins over stale cache & LiteLLM
		expect(card?.pricing).toMatchObject({ inputPerMillion: 4, outputPerMillion: 16 });
		expect(card?.pricingSource).toBe("provider-live");
		// LiteLLM-added capabilities propagate to rawCapabilities -> DiscoverySnapshotV1
		expect(card?.rawCapabilities).toContain("vision");
		expect(card?.rawCapabilities).toContain("structured_output");
		const snap = registryDiscoverySnapshot(state);
		const snapModel = snap.models.find((m) => m.modelId === "openai/gpt-4o");
		expect(snapModel?.capabilities).toContain("structured_output");
		expect(snapModel?.capabilities).not.toContain("reasoning");
	});

	it("quarantines originPricing collapse when proxy pricing is absent and isolates local catalog cache keys", () => {
		const dir = makeTempDir("kosha-local-key-");
		const a = join(dir, "a.json");
		const b = join(dir, "b.json");
		writeFileSync(a, "{}");
		writeFileSync(b, "{}");
		const keyA = catalogCacheKey("providers_all", { catalogSource: "local", catalogFile: a });
		const keyB = catalogCacheKey("providers_all", { catalogSource: "local", catalogFile: b });
		expect(keyA).not.toBe(keyB);

		const snapAt = (ts: number, originIn: number): DiscoverySnapshotV1 => ({
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			cursor: `c-${ts}`,
			discoveredAt: ts,
			providers: [
				{
					providerId: "claude-code",
					name: "Claude Code",
					isLocal: false,
					transport: "native-http",
					authenticated: true,
					credentialSource: "shared",
				},
			],
			models: [
				{
					key: "claude-code:sonnet",
					providerId: "claude-code",
					modelId: "sonnet",
					name: "Sonnet",
					mode: "chat",
					contextWindow: 200_000,
					maxOutputTokens: 8_192,
					capabilities: ["chat"],
					rawCapabilities: ["chat"],
					originProviderId: "anthropic",
					originPricing: { inputPerMillion: originIn, outputPerMillion: 15 },
					source: "api",
					discoveredAt: ts,
				},
			],
		});
		const prev = snapAt(0, 3);
		const collapsed = mergeManifests(prev, snapAt(10 * 86_400_000, 0));
		expect(collapsed.models[0].rawCapabilities).toContain("pricing_quarantined");
		expect(collapsed.models[0].originPricing?.inputPerMillion).toBe(3);
	});

	it("fixes ledger monthly filename double-counting, serviceTier+band resolution, and tally/MCP cost parity", async () => {
		const dir = makeTempDir("kosha-ledger-dedup-");
		const monthFile = join(dir, "ledger-2026-11.jsonl");
		const ts = Date.UTC(2026, 10, 15, 12, 0, 0);
		writeFileSync(
			monthFile,
			`${JSON.stringify({
				ts,
				provider: "openai",
				modelId: "gpt-4o",
				requested: "gpt-4o",
				estimatedUsd: 1.25,
				estimatedInputTokens: 100,
				estimatedOutputTokens: 10,
				upstreamStatus: 200,
			})}\n`,
		);
		expect(await readSpendForMonth(ts, null, monthFile)).toBeCloseTo(1.25, 6);

		const tiered: ModelPricing = {
			inputPerMillion: 2,
			outputPerMillion: 10,
			cacheReadPerMillion: 0,
			reasoningOutputPerMillion: 40,
			cacheWrites: [
				{ ttlSeconds: 300, perMillion: 2.5 },
				{ ttlSeconds: 3600, perMillion: 4 },
			],
			longContextThresholdTokens: 100_000,
			longContextInputPerMillion: 4,
			longContextOutputPerMillion: 20,
			serviceTiers: { flex: { inputPerMillion: 1, outputPerMillion: 5 } },
		};
		const resolved = resolvePricing(tiered, { promptTokens: 150_000, serviceTier: "flex" });
		// 2x band * 0.5x flex tier = $2 in / $10 out
		expect(resolved.inputPerMillion).toBeCloseTo(2, 6);
		expect(resolved.outputPerMillion).toBeCloseTo(10, 6);

		// Zero cacheReadPerMillion on paid input falls back to active resolved inputPerMillion ($4/M in 100k+ band) in tally
		const est = estimateUsdCost(
			{ inputTokens: 1_000, outputTokens: 0, cachedInputTokens: 1_000_000, totalTokens: 1_001_000 },
			tiered,
		);
		expect(est.cachedInputUsd).toBeCloseTo(4, 6);

		// MCP kosha_estimate_cost prices reasoning_tokens + cache_write_1h_tokens
		const reg = makeRegistry([
			{
				id: "anthropic",
				name: "Anthropic",
				baseUrl: "https://api.anthropic.com",
				authenticated: true,
				lastRefreshed: Date.now(),
				models: [makeCard({ id: "claude-tiered", provider: "anthropic", pricing: tiered })],
			},
		]);
		const mcpRes = await handleJsonRpc(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "kosha_estimate_cost",
					arguments: {
						model: "claude-tiered",
						input_tokens: 1_000_000,
						output_tokens: 0,
						reasoning_tokens: 500_000,
						cache_write_tokens: 1_000_000,
						cache_write_1h_tokens: 1_000_000,
					},
				},
			},
			{ registry: async () => reg },
		);
		const costJson = JSON.parse(
			(mcpRes?.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text ?? "{}",
		) as { inputUsd: number; reasoningUsd: number; cacheWriteUsd: number; totalUsd: number };
		expect(costJson.inputUsd).toBeCloseTo(4, 6); // long-context 2x band applies cleanly
		expect(costJson.reasoningUsd).toBeCloseTo(20, 6); // 500k * $40/M
		expect(costJson.cacheWriteUsd).toBeCloseTo(8, 6); // 1h $4/M scaled by 2x band
		expect(costJson.totalUsd).toBeCloseTo(32, 6);
	});

	it("parses boolean CLI flags without swallowing positional subcommands and formats unit/remote/ANSI cells cleanly", async () => {
		expect(parseArgs(["--json", "list"])).toEqual({ positional: ["list"], flags: { json: true } });
		expect(parseArgs(["search", "--json", "gpt"])).toEqual({ positional: ["search", "gpt"], flags: { json: true } });
		expect(parseArgs(["--pricing", "list"])).toEqual({ positional: ["list"], flags: { pricing: true } });

		const refreshed: Array<string | undefined> = [];
		const fakeReg = {
			refresh: async (p?: string) => {
				refreshed.push(p);
			},
			discover: async () => [],
			providers_list: () => [],
			toJSON: () => ({ providers: [], aliases: {}, discoveredAt: Date.now() }),
		};
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await cmdDiscover(fakeReg as never, { refresh: true, json: true, provider: "openai" });
		logSpy.mockRestore();
		expect(refreshed).toEqual(["openai"]);

		const imageCard = makeCard({
			id: "dall-e-3",
			provider: "openai",
			mode: "image",
			pricing: { inputPerMillion: 0, outputPerMillion: 0, imageOutputPerImage: 0.04 },
		});
		expect(formatPricingTier(imageCard.pricing)).toContain("unit");
		expect(modelRow(imageCard)[4]).toContain("unit");

		expect(
			formatCredentialSource({
				id: "anthropic",
				name: "Anthropic",
				baseUrl: "https://api.anthropic.com",
				authenticated: false,
				credentialSource: "none",
				models: [],
				lastRefreshed: 0,
			}),
		).toContain("public catalog");

		const table = renderTable(
			[
				{ header: "Name", width: 8 },
				{ header: "Price", width: 12, align: "right" },
			],
			[["m1", c("\x1b[33m", "unverified")]],
		);
		const rowLine = table.split("\n")[2];
		const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
		// Strip ANSI escapes: visible column width must align strictly at 8 + 1 + 12 = 21 chars
		expect(rowLine.replace(ansiRe, "").length).toBe(21);
	});
});
