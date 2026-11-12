/**
 * The trusted-price gate: a price the manifest merge holds is the price kosha
 * itself routes and budgets with, and a rate no catalog can mean (negative,
 * NaN, infinite) never reaches ranking or the ledger.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateRequestCost, ledgerRowUsd } from "../src/cost.js";
import { sanitizePricing } from "../src/price-trust.js";
import { ModelRegistry } from "../src/registry.js";
import { registryClassifyError, registryRecordObservation } from "../src/registry-discovery.js";
import { registryDiscover } from "../src/registry-runtime.js";
import type { DiscoveryDependencies, RegistryState } from "../src/registry-state.js";
import { createRegistryState } from "../src/registry-state.js";
import type { ModelCard, ModelPricing, ProviderDiscoverer } from "../src/types.js";

function card(id: string, pricing?: ModelPricing): ModelCard {
	return {
		id,
		name: id,
		provider: "anthropic",
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 200_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "api",
		...(pricing ? { pricing } : {}),
	};
}

let workDir: string;
beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "kosha-price-gate-"));
});
afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function deps(state: RegistryState, models: () => ModelCard[], saves: { count: number }): DiscoveryDependencies {
	const discoverer: ProviderDiscoverer = {
		providerId: "anthropic",
		providerName: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		async discover() {
			return models().map((m) => ({ ...m, pricing: m.pricing ? { ...m.pricing } : undefined }));
		},
	};
	return {
		resolveCredential: null,
		loadDiscoverers: async () => [discoverer],
		enrichModels: async () => undefined,
		populateModelAliases: () => undefined,
		loadFromCache: async () => false,
		saveToCache: async () => {
			saves.count += 1;
		},
		fallbackCredential: () => ({ source: "none" }),
		snapshotForDelta: () => null,
		recordDiscoveryMutation: () => {
			state.lastSnapshotCache = null;
		},
		recordObservation: (providerId, entry) => registryRecordObservation(state, providerId, entry),
		classifyError: (message) => registryClassifyError(message),
	};
}

describe("a held price reaches kosha's own routing", () => {
	it("keeps the previous price in memory when the merge quarantines a 99% drop", async () => {
		const state = createRegistryState({ cacheDir: join(workDir, "cache") });
		let price: ModelPricing = { inputPerMillion: 10, outputPerMillion: 30 };
		const saves = { count: 0 };
		const d = deps(state, () => [card("claude-x", price)], saves);

		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		expect(state.providerMap.get("anthropic")?.models[0].pricing?.inputPerMillion).toBe(10);

		price = { inputPerMillion: 0.1, outputPerMillion: 0.3 };
		const savesBefore = saves.count;
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });

		const held = state.providerMap.get("anthropic")?.models[0];
		expect(held?.pricing?.inputPerMillion).toBe(10);
		expect(held?.pricing?.outputPerMillion).toBe(30);
		expect(held?.rawCapabilities).toContain("pricing_quarantined");
		// The held price is written back to the cache too, so the next
		// cache hit doesn't resurrect the suspect one.
		expect(saves.count).toBeGreaterThan(savesBefore + 1);
	});

	it("leaves an ordinary small move alone", async () => {
		const state = createRegistryState({ cacheDir: join(workDir, "cache") });
		let price: ModelPricing = { inputPerMillion: 10, outputPerMillion: 30 };
		const d = deps(state, () => [card("claude-x", price)], { count: 0 });
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		price = { inputPerMillion: 9, outputPerMillion: 27 };
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		const model = state.providerMap.get("anthropic")?.models[0];
		expect(model?.pricing?.inputPerMillion).toBe(9);
		expect(model?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
	});
});

describe("rates no catalog can mean", () => {
	it("drops the whole block when a token rate is negative or not finite", () => {
		expect(sanitizePricing({ inputPerMillion: -1, outputPerMillion: 2 })).toBeUndefined();
		expect(sanitizePricing({ inputPerMillion: 1, outputPerMillion: Number.NaN })).toBeUndefined();
		expect(sanitizePricing({ inputPerMillion: Number.POSITIVE_INFINITY, outputPerMillion: 1 })).toBeUndefined();
	});

	it("removes only a bad optional rate", () => {
		const out = sanitizePricing({ inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: -0.5 });
		expect(out).toEqual({ inputPerMillion: 1, outputPerMillion: 2 });
	});

	it("returns the same object when every rate is sane", () => {
		const p = { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 };
		expect(sanitizePricing(p)).toBe(p);
	});

	it("never discovers a negative price into the registry", async () => {
		const state = createRegistryState({ cacheDir: join(workDir, "cache") });
		const d = deps(
			state,
			() => [
				card("evil", { inputPerMillion: -1e6, outputPerMillion: -1e6 }),
				card("ok", { inputPerMillion: 1, outputPerMillion: 2 }),
			],
			{ count: 0 },
		);
		await registryDiscover(state, d, { force: true, enrichWithPricing: false });
		const byId = new Map(state.providerMap.get("anthropic")?.models.map((m) => [m.id, m]));
		expect(byId.get("evil")?.pricing).toBeUndefined();
		expect(byId.get("ok")?.pricing?.inputPerMillion).toBe(1);
	});

	it("keeps a negative price out of a serialized registry and out of cheapest", () => {
		const registry = ModelRegistry.fromJSON({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					baseUrl: "https://api.anthropic.com",
					authenticated: true,
					credentialSource: "env",
					lastRefreshed: Date.now(),
					models: [
						card("evil", { inputPerMillion: -1e6, outputPerMillion: -1e6 }),
						card("ok", { inputPerMillion: 1, outputPerMillion: 2 }),
					],
				},
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const ranked = registry.cheapestModels({ limit: 5 });
		const ids = ranked.matches.map((m) => m.model.id);
		expect(ids).not.toContain("evil");
		expect(ids[0]).toBe("ok");
	});

	it("never prices a request below $0, and a request row never credits spend", () => {
		expect(
			estimateRequestCost(card("evil", { inputPerMillion: -1, outputPerMillion: -1 }), { messages: [] }),
		).toBeNull();
		expect(ledgerRowUsd({ estimatedUsd: -516 })).toBe(0);
		expect(ledgerRowUsd({ estimatedUsd: 1, actualUsd: -3 })).toBe(0);
		// A reconciliation row is the one place a negative delta is real.
		expect(ledgerRowUsd({ estimatedUsd: 0, kind: "adjustment", adjustmentUsd: -0.4 })).toBe(-0.4);
	});
});
