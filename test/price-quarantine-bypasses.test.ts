/**
 * Ways a bad price used to get past quarantine without waiting: rates outside
 * the five checked fields, a cache rate dropped to $0, a near-zero rate, a
 * `schedule` field from untrusted data, a failed or unreadable manifest, and
 * flags no reader acted on. Plus the escape hatch, `kosha registry accept`.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actualCostFromUsage } from "../src/cost.js";
import type { DiscoveryModelV1, DiscoverySnapshotV1 } from "../src/discovery-contract.js";
import { DISCOVERY_SCHEMA_VERSION } from "../src/discovery-contract.js";
import { registryClassifyError, registryRecordObservation } from "../src/registry-discovery.js";
import { acceptHeldPrice, applyManifestHolds, mergeManifests, registryDiscover } from "../src/registry-runtime.js";
import type { DiscoveryDependencies, RegistryState } from "../src/registry-state.js";
import { createRegistryState } from "../src/registry-state.js";
import type { ModelCard, ModelPricing, ProviderDiscoverer } from "../src/types.js";

const DAY = 24 * 60 * 60 * 1000;

function row(key: string, pricing: ModelPricing, extra: Partial<DiscoveryModelV1> = {}): DiscoveryModelV1 {
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
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		pricing,
		dimensions: null,
		maxInputTokens: null,
		discoveredAt: 0,
		source: "api",
		...extra,
	} as DiscoveryModelV1;
}

function at(models: DiscoveryModelV1[], discoveredAt: number): DiscoverySnapshotV1 {
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

const find = (m: DiscoverySnapshotV1, key = "openai:m") => m.models.find((r) => r.key === key);
const tags = (m: DiscoverySnapshotV1, key?: string) => find(m, key)?.rawCapabilities ?? [];

describe("every billed rate is checked", () => {
	it("holds a per-image price that collapses", () => {
		const prev = at([row("openai:m", { inputPerMillion: 1, outputPerMillion: 2, imageOutputPerImage: 0.04 })], 0);
		const merged = mergeManifests(
			prev,
			at([row("openai:m", { inputPerMillion: 1, outputPerMillion: 2, imageOutputPerImage: 0.0001 })], DAY),
		);
		expect(tags(merged)).toContain("pricing_quarantined");
		expect(find(merged)?.pricing?.imageOutputPerImage).toBe(0.04);
	});

	it("keeps the last cache rate when a catalog reports it as $0", () => {
		const prev = at([row("openai:m", { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 })], 0);
		const merged = mergeManifests(
			prev,
			at([row("openai:m", { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0 })], DAY),
		);
		expect(find(merged)?.pricing?.cacheReadPerMillion).toBe(0.3);
		expect(tags(merged)).not.toContain("pricing_quarantined");
	});

	it("never releases a rate cut to under 1% by waiting", () => {
		const prev = at([row("openai:m", { inputPerMillion: 10, outputPerMillion: 30 })], 0);
		const bad = () => [row("openai:m", { inputPerMillion: 0.000001, outputPerMillion: 30 })];
		const held = mergeManifests(prev, at(bad(), DAY));
		const later = mergeManifests(held, at(bad(), 60 * DAY));
		expect(find(later)?.pricing?.inputPerMillion).toBe(10);
		expect(tags(later)).toContain("pricing_quarantined");
	});
});

describe("upgrading keeps every hold's clock", () => {
	it("matches a hold recorded with the old five-field fingerprint", () => {
		const fresh = { inputPerMillion: 1, outputPerMillion: 3 };
		const legacy = JSON.stringify([
			[1, 3, null, null, null],
			[null, null, null, null, null],
		]);
		const prev = at(
			[
				row("openai:m", { inputPerMillion: 10, outputPerMillion: 30 }, {
					rawCapabilities: ["pricing_quarantined"],
					pricingHold: { rates: legacy, since: 0 },
				} as Partial<DiscoveryModelV1>),
			],
			0,
		);
		// Three days after the hold began, a single-source move is released.
		const merged = mergeManifests(prev, at([row("openai:m", fresh)], 3 * DAY + 1));
		expect(find(merged)?.pricing?.inputPerMillion).toBe(1);
	});
});

describe("only kosha's own schedules skip quarantine", () => {
	it("quarantines a 99.9% drop that carries a schedule field", () => {
		const schedule = { offPeak: { inputPerMillion: 0, outputPerMillion: 0 }, peakWindows: [], source: "x" };
		const prev = at([row("openai:m", { inputPerMillion: 10, outputPerMillion: 30 })], 0);
		const merged = mergeManifests(
			prev,
			at([row("openai:m", { inputPerMillion: 0.01, outputPerMillion: 0.03, schedule } as ModelPricing)], DAY),
		);
		expect(find(merged)?.pricing?.inputPerMillion).toBe(10);
	});

	it("lets the curated DeepSeek schedule through", () => {
		const prev = at([row("deepseek:deepseek-flash", { inputPerMillion: 2, outputPerMillion: 8 })], 0);
		const schedule = { offPeak: { inputPerMillion: 0.15, outputPerMillion: 0.6 }, peakWindows: [], source: "x" };
		const merged = mergeManifests(
			prev,
			at(
				[row("deepseek:deepseek-flash", { inputPerMillion: 0.3, outputPerMillion: 1.2, schedule } as ModelPricing)],
				DAY,
			),
		);
		expect(find(merged, "deepseek:deepseek-flash")?.pricing?.inputPerMillion).toBe(0.3);
	});
});

describe("held and disputed rows are budgeted at the highest reported rate", () => {
	function stateWith(model: ModelCard): RegistryState {
		const state = createRegistryState({});
		state.providerMap.set("openai", {
			id: "openai",
			name: "OpenAI",
			baseUrl: "https://api.openai.com/v1",
			authenticated: true,
			credentialSource: "env",
			models: [model],
			lastRefreshed: 0,
		});
		return state;
	}
	const model = (pricing: ModelPricing, extra: Partial<ModelCard> = {}): ModelCard => ({
		id: "m",
		name: "m",
		provider: "openai",
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: 0,
		source: "api",
		pricing,
		...extra,
	});

	it("uses the dearer source when sources disagree", () => {
		const evidence = [
			{ source: "models.dev" as const, inputPerMillion: 3, outputPerMillion: 15 },
			{ source: "litellm" as const, inputPerMillion: 6, outputPerMillion: 30 },
		];
		const state = stateWith(model({ inputPerMillion: 3, outputPerMillion: 15 }, { priceEvidence: evidence }));
		const manifest = at(
			[
				row(
					"openai:m",
					{ inputPerMillion: 3, outputPerMillion: 15 },
					{ rawCapabilities: ["pricing_sources_disagree"] },
				),
			],
			0,
		);
		expect(applyManifestHolds(state, manifest)).toBe(true);
		expect(state.providerMap.get("openai")?.models[0].pricing).toMatchObject({
			inputPerMillion: 6,
			outputPerMillion: 30,
		});
		expect(applyManifestHolds(state, manifest)).toBe(false); // idempotent
	});

	it("copies a secondary rate the merge kept back into memory", () => {
		// The catalog reported cache-write and image as 0; the merge keeps the
		// last real rate in registry.json, and routing and the budget must too.
		const state = stateWith(
			model({
				inputPerMillion: 3,
				outputPerMillion: 15,
				cacheWritePerMillion: 0,
				imageInputPerImage: 0,
			} as ModelPricing),
		);
		const manifest = at(
			[
				row("openai:m", {
					inputPerMillion: 3,
					outputPerMillion: 15,
					cacheWritePerMillion: 3.75,
					imageInputPerImage: 0.004,
				} as ModelPricing),
			],
			0,
		);
		expect(applyManifestHolds(state, manifest)).toBe(true);
		expect(state.providerMap.get("openai")?.models[0].pricing).toMatchObject({
			cacheWritePerMillion: 3.75,
			imageInputPerImage: 0.004,
		});
		expect(applyManifestHolds(state, manifest)).toBe(false); // idempotent
	});

	it("keeps the held price for a suspect drop, and takes a suspect rise at once", () => {
		const heldRow = row(
			"openai:m",
			{ inputPerMillion: 10, outputPerMillion: 30 },
			{ rawCapabilities: ["pricing_quarantined"] },
		);
		const down = stateWith(model({ inputPerMillion: 1, outputPerMillion: 3 }));
		applyManifestHolds(down, at([heldRow], 0));
		expect(down.providerMap.get("openai")?.models[0].pricing).toMatchObject({
			inputPerMillion: 10,
			outputPerMillion: 30,
		});

		const up = stateWith(model({ inputPerMillion: 100, outputPerMillion: 300 }));
		applyManifestHolds(up, at([heldRow], 0));
		expect(up.providerMap.get("openai")?.models[0].pricing).toMatchObject({
			inputPerMillion: 100,
			outputPerMillion: 300,
		});
	});
});

describe("a $0 cache rate on paid input", () => {
	it("is billed at the fallback ratio, not free", () => {
		const m = {
			id: "m",
			provider: "openai",
			pricing: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0 },
		} as ModelCard;
		const cost = actualCostFromUsage(
			m,
			{ prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1_000_000 } },
			"openai",
		);
		expect(cost?.usd).toBeCloseTo(1, 6); // 1M cached tokens at half of $2
	});
});

// ── Discovery-level: the manifest on disk ────────────────────────────────────

let workDir: string;
beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "kosha-quarantine-"));
});
afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function card(pricing: ModelPricing): ModelCard {
	return {
		id: "claude-x",
		name: "claude-x",
		provider: "anthropic",
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 200_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "api",
		pricing,
	};
}

function deps(state: RegistryState, price: () => ModelPricing): DiscoveryDependencies {
	const discoverer: ProviderDiscoverer = {
		providerId: "anthropic",
		providerName: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		async discover() {
			return [card({ ...price() })];
		},
	};
	return {
		resolveCredential: null,
		loadDiscoverers: async () => [discoverer],
		enrichModels: async () => undefined,
		populateModelAliases: () => undefined,
		loadFromCache: async () => false,
		saveToCache: async () => undefined,
		fallbackCredential: () => ({ source: "none" }),
		snapshotForDelta: () => null,
		recordDiscoveryMutation: () => {
			state.lastSnapshotCache = null;
		},
		recordObservation: (providerId, entry) => registryRecordObservation(state, providerId, entry),
		classifyError: (message) => registryClassifyError(message),
	};
}

const memoryInput = (state: RegistryState) => state.providerMap.get("anthropic")?.models[0].pricing?.inputPerMillion;

describe("the manifest baseline fails closed", () => {
	it("judges against the newest backup when the manifest is unreadable", async () => {
		const state = createRegistryState({ cacheDir: join(workDir, "cache") });
		let price: ModelPricing = { inputPerMillion: 10, outputPerMillion: 30 };
		const d = deps(state, () => price);
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });

		const manifest = join(workDir, "registry.json");
		copyFileSync(manifest, `${manifest}.bak.2026-01-01`);
		writeFileSync(manifest, "{ not json");
		price = { inputPerMillion: 0.1, outputPerMillion: 0.3 };
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		expect(memoryInput(state)).toBe(10);
	});

	it("still applies holds when the manifest write can't take its lock", async () => {
		const state = createRegistryState({ cacheDir: join(workDir, "cache") });
		let price: ModelPricing = { inputPerMillion: 10, outputPerMillion: 30 };
		const d = deps(state, () => price);
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });

		writeFileSync(join(workDir, "registry.json.lock"), "held by another process");
		price = { inputPerMillion: 0.1, outputPerMillion: 0.3 };
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		expect(memoryInput(state)).toBe(10);
	}, 10_000);
});

describe("kosha registry accept", () => {
	it("releases exactly the held rates, and judges a different publish afresh", async () => {
		const state = createRegistryState({ cacheDir: join(workDir, "cache") });
		let price: ModelPricing = { inputPerMillion: 10, outputPerMillion: 30 };
		const d = deps(state, () => price);
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });

		price = { inputPerMillion: 0, outputPerMillion: 0 }; // never released by time
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		expect(memoryInput(state)).toBe(10);

		expect((await acceptHeldPrice(state, "anthropic", "claude-x")).status).toBe("accepted");
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		expect(memoryInput(state)).toBe(0);

		// Accepting isn't a blank cheque: a new collapse from the accepted price
		// is a new hold. From $0 there's nothing lower, so start from a fresh price.
		price = { inputPerMillion: 5, outputPerMillion: 15 };
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		price = { inputPerMillion: 0.01, outputPerMillion: 15 };
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		expect(memoryInput(state)).toBe(5);
	});

	it("reports a model with nothing held", async () => {
		const state = createRegistryState({ cacheDir: join(workDir, "cache") });
		await registryDiscover(
			state,
			deps(state, () => ({ inputPerMillion: 1, outputPerMillion: 2 })),
			{
				force: true,
				enrichWithPricing: false,
			},
		);
		expect((await acceptHeldPrice(state, "anthropic", "claude-x")).status).toBe("not-held");
		expect((await acceptHeldPrice(state, "anthropic", "nope")).status).toBe("not-found");
	});
});
