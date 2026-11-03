/**
 * Tests for the pricing-quarantine and model-lifecycle TTL rules in
 * mergeManifests. These run pure on the merge function — no I/O, no disk —
 * because the policy is the load-bearing piece.
 */

import { describe, expect, it } from "vitest";
import type { DiscoveryModelV1, DiscoverySnapshotV1 } from "../src/discovery-contract.js";
import { DISCOVERY_SCHEMA_VERSION } from "../src/discovery-contract.js";
import { mergeManifests } from "../src/registry-runtime.js";

function emptyModel(key: string, overrides: Partial<DiscoveryModelV1> = {}): DiscoveryModelV1 {
	return {
		key,
		modelId: key.split(":")[1] ?? key,
		name: key,
		providerId: key.split(":")[0] ?? "p",
		canonicalProviderId: key.split(":")[0] ?? "p",
		originProviderId: key.split(":")[0] ?? "p",
		mode: "chat",
		capabilities: [],
		rawCapabilities: [],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		pricing: null,
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
		...overrides,
	};
}

function snapshot(models: DiscoveryModelV1[]): DiscoverySnapshotV1 {
	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		discoveredAt: 0,
		cursor: "",
		providers: [],
		models,
		roles: [],
		health: [],
		credentialPrompts: [],
	};
}

describe("mergeManifests: pricing quarantine", () => {
	it("keeps the previous price when the fresh value moves more than 75%", () => {
		const prev = snapshot([emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 3, outputPerMillion: 15 } })]);
		const fresh = snapshot([
			emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 0.1, outputPerMillion: 15 } }),
		]);
		const merged = mergeManifests(prev, fresh);
		const row = merged.models.find((m) => m.key === "anthropic:sonnet");
		expect(row?.pricing?.inputPerMillion).toBe(3); // quarantined → previous wins
		expect(row?.rawCapabilities).toContain("pricing_quarantined");
	});

	it("accepts a scheduled price however far it moved", () => {
		const prev = snapshot([
			emptyModel("deepseek:deepseek-flash", { pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 } }),
		]);
		const schedule = {
			offPeak: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
			peakWindows: [{ days: [1], startHourUtc: 1, endHourUtc: 4 }],
			source: "https://example.test",
		};
		const fresh = snapshot([
			emptyModel("deepseek:deepseek-flash", { pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, schedule } }),
		]);
		const row = mergeManifests(prev, fresh).models.find((m) => m.key === "deepseek:deepseek-flash");
		expect(row?.pricing?.inputPerMillion).toBe(0.3);
		expect(row?.pricing?.schedule).toEqual(schedule);
		expect(row?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
	});

	it("lets a small price change through without quarantining", () => {
		const prev = snapshot([emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 3, outputPerMillion: 15 } })]);
		const fresh = snapshot([
			emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 3.3, outputPerMillion: 16 } }),
		]);
		const merged = mergeManifests(prev, fresh);
		const row = merged.models.find((m) => m.key === "anthropic:sonnet");
		expect(row?.pricing?.inputPerMillion).toBe(3.3);
		expect(row?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
	});

	it("quarantines a priced model whose rates drop to $0", () => {
		const prev = snapshot([emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 3, outputPerMillion: 15 } })]);
		const fresh = snapshot([emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 0, outputPerMillion: 0 } })]);
		const merged = mergeManifests(prev, fresh);
		const row = merged.models.find((m) => m.key === "anthropic:sonnet");
		expect(row?.pricing?.inputPerMillion).toBe(3);
		expect(row?.rawCapabilities).toContain("pricing_quarantined");
	});

	describe("releasing a held price", () => {
		const DAY = 24 * 60 * 60 * 1000;
		const at = (models: DiscoveryModelV1[], discoveredAt: number) => ({ ...snapshot(models), discoveredAt });
		const priced = (inputPerMillion: number) =>
			emptyModel("anthropic:sonnet", { pricing: { inputPerMillion, outputPerMillion: 15 } });
		const row = (s: DiscoverySnapshotV1) => s.models.find((m) => m.key === "anthropic:sonnet");

		it("accepts rates still published after three days, across saved manifests", () => {
			const first = mergeManifests(at([priced(3)], 0), at([priced(0.1)], DAY));
			expect(row(first)?.pricing?.inputPerMillion).toBe(3);

			// Round-trip through JSON: the hold has to survive being written to disk.
			const saved = JSON.parse(JSON.stringify(first)) as DiscoverySnapshotV1;
			const nearly = mergeManifests(saved, at([priced(0.1)], DAY * 4 - 1));
			expect(row(nearly)?.pricing?.inputPerMillion).toBe(3);
			expect(row(nearly)?.rawCapabilities).toContain("pricing_quarantined");

			const released = mergeManifests(nearly, at([priced(0.1)], DAY * 4));
			expect(row(released)?.pricing?.inputPerMillion).toBe(0.1);
			expect(row(released)?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
			expect(row(released)).not.toHaveProperty("pricingHold");
		});

		it("restarts the clock when the published rates change", () => {
			const first = mergeManifests(at([priced(3)], 0), at([priced(0.1)], DAY));
			const changed = mergeManifests(first, at([priced(0.2)], DAY * 3));
			const later = mergeManifests(changed, at([priced(0.2)], DAY * 5));
			expect(row(later)?.pricing?.inputPerMillion).toBe(3);
			const released = mergeManifests(later, at([priced(0.2)], DAY * 6));
			expect(row(released)?.pricing?.inputPerMillion).toBe(0.2);
		});

		it("never accepts a billed rate of $0", () => {
			const first = mergeManifests(at([priced(3)], 0), at([priced(0)], DAY));
			const later = mergeManifests(first, at([priced(0)], DAY * 60));
			expect(row(later)?.pricing?.inputPerMillion).toBe(3);
			expect(row(later)?.rawCapabilities).toContain("pricing_quarantined");
		});

		it("drops the hold when the catalog returns to the old price", () => {
			const first = mergeManifests(at([priced(3)], 0), at([priced(0.1)], DAY));
			const back = mergeManifests(first, at([priced(3)], DAY * 2));
			expect(row(back)).not.toHaveProperty("pricingHold");
			expect(row(back)?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
		});
	});

	it("still treats a zero cache rate as not reported", () => {
		const prev = snapshot([
			emptyModel("anthropic:sonnet", {
				pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
			}),
		]);
		const fresh = snapshot([
			emptyModel("anthropic:sonnet", {
				pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0 },
			}),
		]);
		const merged = mergeManifests(prev, fresh);
		const row = merged.models.find((m) => m.key === "anthropic:sonnet");
		expect(row?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
	});
});

describe("mergeManifests: model lifecycle TTL", () => {
	it("preserves a missing model with an incremented missingRunCount", () => {
		const prev = snapshot([emptyModel("openai:gpt-old", { pricing: { inputPerMillion: 1, outputPerMillion: 2 } })]);
		const fresh = snapshot([]);
		const merged = mergeManifests(prev, fresh);
		const row = merged.models.find((m) => m.key === "openai:gpt-old");
		expect(row).toBeDefined();
		expect(row?.missingRunCount).toBe(1);
	});

	it("drops a model whose missingRunCount exceeds the TTL", () => {
		const prev = snapshot([
			emptyModel("openai:gpt-zombie", {
				missingRunCount: 14,
				pricing: { inputPerMillion: 1, outputPerMillion: 2 },
			}),
		]);
		const fresh = snapshot([]);
		const merged = mergeManifests(prev, fresh);
		expect(merged.models.find((m) => m.key === "openai:gpt-zombie")).toBeUndefined();
	});

	it("resets missingRunCount when a model reappears", () => {
		const prev = snapshot([
			emptyModel("openai:gpt-back", {
				missingRunCount: 7,
				pricing: { inputPerMillion: 1, outputPerMillion: 2 },
			}),
		]);
		const fresh = snapshot([emptyModel("openai:gpt-back", { pricing: { inputPerMillion: 1, outputPerMillion: 2 } })]);
		const merged = mergeManifests(prev, fresh);
		const row = merged.models.find((m) => m.key === "openai:gpt-back");
		expect(row?.missingRunCount).toBe(0);
	});
});
