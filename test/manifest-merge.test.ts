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

	describe("how much the sources agree", () => {
		const DAY = 24 * 60 * 60 * 1000;
		const at = (models: DiscoveryModelV1[], discoveredAt: number) => ({ ...snapshot(models), discoveredAt });
		const said = (source: string, inputPerMillion: number, outputPerMillion = 15) => ({
			source,
			inputPerMillion,
			outputPerMillion,
		});
		const priced = (inputPerMillion: number, evidence?: ReturnType<typeof said>[], outputPerMillion = 15) =>
			emptyModel("anthropic:sonnet", {
				pricing: { inputPerMillion, outputPerMillion },
				...(evidence ? { priceEvidence: evidence } : {}),
			} as Partial<DiscoveryModelV1>);
		const row = (s: DiscoverySnapshotV1) => s.models.find((m) => m.key === "anthropic:sonnet");
		const twoAgree = [said("models.dev", 0.1), said("litellm", 0.1)];
		const twoDisagree = [said("models.dev", 0.1), said("litellm", 2.9)];

		it("accepts a big move after one day when two sources agree", () => {
			const first = mergeManifests(at([priced(3)], 0), at([priced(0.1, twoAgree)], DAY));
			const early = mergeManifests(first, at([priced(0.1, twoAgree)], 2 * DAY - 1));
			expect(row(early)?.pricing?.inputPerMillion).toBe(3);
			const accepted = mergeManifests(early, at([priced(0.1, twoAgree)], 2 * DAY));
			expect(row(accepted)?.pricing?.inputPerMillion).toBe(0.1);
			expect(row(accepted)?.rawCapabilities ?? []).not.toContain("pricing_single_source");
			expect(row(accepted)?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
		});

		it("makes one source wait three days, and flags it from then on", () => {
			const first = mergeManifests(at([priced(3)], 0), at([priced(0.1)], DAY));
			const early = mergeManifests(first, at([priced(0.1)], 4 * DAY - 1));
			expect(row(early)?.pricing?.inputPerMillion).toBe(3);
			const accepted = mergeManifests(early, at([priced(0.1)], 4 * DAY));
			expect(row(accepted)?.pricing?.inputPerMillion).toBe(0.1);
			expect(row(accepted)?.rawCapabilities).toContain("pricing_single_source");
			const later = mergeManifests(accepted, at([priced(0.1)], 9 * DAY));
			expect(row(later)?.rawCapabilities).toContain("pricing_single_source");
		});

		it("drops the single-source flag once a second source confirms it", () => {
			const accepted = mergeManifests(
				mergeManifests(at([priced(3)], 0), at([priced(0.1)], DAY)),
				at([priced(0.1)], 4 * DAY),
			);
			const confirmed = mergeManifests(accepted, at([priced(0.1, twoAgree)], 5 * DAY));
			expect(row(confirmed)?.rawCapabilities ?? []).not.toContain("pricing_single_source");
		});

		it("holds a disputed move for 7 days, then accepts it and keeps the flag", () => {
			let merged = mergeManifests(at([priced(3)], 0), at([priced(0.1, twoDisagree)], DAY));
			merged = mergeManifests(merged, at([priced(0.1, twoDisagree)], 8 * DAY - 1));
			expect(row(merged)?.pricing?.inputPerMillion).toBe(3);
			expect(row(merged)?.rawCapabilities).toContain("pricing_quarantined");
			expect(row(merged)?.rawCapabilities).toContain("pricing_sources_disagree");

			merged = mergeManifests(merged, at([priced(0.1, twoDisagree)], 8 * DAY));
			expect(row(merged)?.pricing?.inputPerMillion).toBe(0.1);
			expect(row(merged)?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
			expect(row(merged)?.rawCapabilities).toContain("pricing_sources_disagree");

			// No move now, and the dispute stands, so the flag stays visible.
			merged = mergeManifests(merged, at([priced(0.1, twoDisagree)], 9 * DAY));
			expect(row(merged)?.rawCapabilities).toContain("pricing_sources_disagree");
		});

		it("restarts the 7 days when a disputed price changes again", () => {
			let merged = mergeManifests(at([priced(3)], 0), at([priced(0.1, twoDisagree)], DAY));
			merged = mergeManifests(merged, at([priced(0.2, [said("models.dev", 0.2), said("litellm", 3)])], 7 * DAY));
			merged = mergeManifests(merged, at([priced(0.2, [said("models.dev", 0.2), said("litellm", 3)])], 13 * DAY));
			expect(row(merged)?.pricing?.inputPerMillion).toBe(3);
		});

		it("releases a disputed price once the sources settle", () => {
			const held = mergeManifests(at([priced(3)], 0), at([priced(0.1, twoDisagree)], DAY));
			const settled = mergeManifests(held, at([priced(0.1, twoAgree)], 2 * DAY));
			expect(row(settled)?.pricing?.inputPerMillion).toBe(0.1);
			expect(row(settled)?.rawCapabilities ?? []).not.toContain("pricing_sources_disagree");
		});

		it("takes a smaller move but flags it when sources dispute it", () => {
			const lie = [said("models.dev", 4.2), said("litellm", 3)];
			const moved = mergeManifests(at([priced(3)], 0), at([priced(4.2, lie)], DAY));
			expect(row(moved)?.pricing?.inputPerMillion).toBe(4.2);
			expect(row(moved)?.rawCapabilities).toContain("pricing_sources_disagree");
			expect(row(moved)?.rawCapabilities ?? []).not.toContain("pricing_quarantined");
			const still = mergeManifests(moved, at([priced(4.2, lie)], 2 * DAY));
			expect(row(still)?.rawCapabilities).toContain("pricing_sources_disagree");
		});

		it("doesn't flag a price that hasn't moved, however its sources differ", () => {
			const same = mergeManifests(
				at([priced(3)], 0),
				at([priced(3, [said("models.dev", 3), said("litellm", 9)])], DAY),
			);
			expect(row(same)?.rawCapabilities ?? []).not.toContain("pricing_sources_disagree");
		});

		it("refuses a billed $0 even when two sources say so", () => {
			const zero = [said("models.dev", 0, 0), said("litellm", 0, 0)];
			const held = mergeManifests(at([priced(3)], 0), at([priced(0, zero, 0)], DAY));
			const later = mergeManifests(held, at([priced(0, zero, 0)], 60 * DAY));
			expect(row(later)?.pricing?.inputPerMillion).toBe(3);
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
