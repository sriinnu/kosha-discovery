/**
 * Tests for the pricing-quarantine and model-lifecycle TTL rules in
 * mergeManifests. These run pure on the merge function — no I/O, no disk —
 * because the policy is the load-bearing piece.
 */

import { describe, expect, it } from "vitest";
import { mergeManifests } from "../src/registry-runtime.js";
import { DISCOVERY_SCHEMA_VERSION } from "../src/discovery-contract.js";
import type { DiscoveryModelV1, DiscoverySnapshotV1 } from "../src/discovery-contract.js";

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
		const prev = snapshot([
			emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 3, outputPerMillion: 15 } }),
		]);
		const fresh = snapshot([
			emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 0.1, outputPerMillion: 15 } }),
		]);
		const merged = mergeManifests(prev, fresh);
		const row = merged.models.find((m) => m.key === "anthropic:sonnet");
		expect(row?.pricing?.inputPerMillion).toBe(3); // quarantined → previous wins
		expect(row?.rawCapabilities).toContain("pricing_quarantined");
	});

	it("lets a small price change through without quarantining", () => {
		const prev = snapshot([
			emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 3, outputPerMillion: 15 } }),
		]);
		const fresh = snapshot([
			emptyModel("anthropic:sonnet", { pricing: { inputPerMillion: 3.3, outputPerMillion: 16 } }),
		]);
		const merged = mergeManifests(prev, fresh);
		const row = merged.models.find((m) => m.key === "anthropic:sonnet");
		expect(row?.pricing?.inputPerMillion).toBe(3.3);
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
