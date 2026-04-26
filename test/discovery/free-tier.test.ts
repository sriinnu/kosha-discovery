import { describe, expect, it } from "vitest";
import { FREE_TIER_CAPABILITY, applyFreeTierFlag, isFreeTier } from "../../src/discovery/free-tier.js";
import type { ModelCard } from "../../src/types.js";

function card(pricing: ModelCard["pricing"]): ModelCard {
	return {
		id: "test-model",
		name: "Test Model",
		provider: "test",
		originProvider: "test",
		mode: "chat",
		capabilities: ["chat"],
		rawCapabilities: ["chat"],
		contextWindow: 0,
		maxOutputTokens: 0,
		pricing,
		aliases: [],
		discoveredAt: 0,
		source: "litellm",
	};
}

describe("free-tier flag", () => {
	it("adds the flag when both prices are exactly 0", () => {
		const result = applyFreeTierFlag(card({ inputPerMillion: 0, outputPerMillion: 0 }));
		expect(result.capabilities).toContain(FREE_TIER_CAPABILITY);
		expect(result.rawCapabilities).toContain(FREE_TIER_CAPABILITY);
		expect(isFreeTier(result)).toBe(true);
	});

	it("does not add the flag when pricing is undefined (unknown != free)", () => {
		const result = applyFreeTierFlag(card(undefined));
		expect(result.capabilities).not.toContain(FREE_TIER_CAPABILITY);
		expect(isFreeTier(result)).toBe(false);
	});

	it("does not add the flag when only one side is 0", () => {
		const half = applyFreeTierFlag(card({ inputPerMillion: 0, outputPerMillion: 5 }));
		expect(half.capabilities).not.toContain(FREE_TIER_CAPABILITY);
	});

	it("is idempotent — calling twice does not duplicate the flag", () => {
		const once = applyFreeTierFlag(card({ inputPerMillion: 0, outputPerMillion: 0 }));
		const twice = applyFreeTierFlag(once);
		expect(twice.capabilities.filter((c) => c === FREE_TIER_CAPABILITY)).toHaveLength(1);
	});

	it("preserves existing capabilities", () => {
		const start = card({ inputPerMillion: 0, outputPerMillion: 0 });
		start.capabilities = ["chat", "vision", "function_calling"];
		const result = applyFreeTierFlag(start);
		expect(result.capabilities).toEqual(["chat", "vision", "function_calling", FREE_TIER_CAPABILITY]);
	});
});
