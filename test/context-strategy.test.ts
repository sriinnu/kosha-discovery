import { describe, expect, it } from "vitest";
import { computeContextStrategy } from "../src/context-strategy.js";
import type { ModelCard, ModelPricing } from "../src/types.js";

function model(overrides: Partial<ModelCard> = {}): ModelCard {
	return {
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		provider: "anthropic",
		mode: "chat",
		capabilities: ["chat", "tool_use"],
		contextWindow: 200_000,
		maxOutputTokens: 8192,
		aliases: ["sonnet"],
		discoveredAt: 0,
		source: "manual",
		...overrides,
	};
}

const claudePricing: ModelPricing = {
	inputPerMillion: 3,
	outputPerMillion: 15,
	cacheReadPerMillion: 0.3,
	cacheWritePerMillion: 3.75,
};

const geminiPricing: ModelPricing = {
	inputPerMillion: 1.25,
	outputPerMillion: 5,
	longContextThresholdTokens: 128_000,
	longContextInputPerMillion: 2.5,
	longContextOutputPerMillion: 10,
};

const groqPricing: ModelPricing = { inputPerMillion: 0.59, outputPerMillion: 0.79 };

describe("computeContextStrategy", () => {
	it("computes situation headroom against the model's context window", () => {
		const result = computeContextStrategy({
			model: model({ pricing: claudePricing }),
			currentTokens: 180_000,
		});

		expect(result.situation.tokensUsed).toBe(180_000);
		expect(result.situation.contextWindow).toBe(200_000);
		expect(result.situation.headroomTokens).toBe(20_000);
		expect(result.situation.headroomPercent).toBeCloseTo(10, 1);
		expect(result.situation.inLongContextTier).toBe(false);
	});

	it("includes Anthropic cache behavior and estimates cached-turn cost", () => {
		const result = computeContextStrategy({
			model: model({ pricing: claudePricing }),
			currentTokens: 100_000,
		});

		expect(result.cacheBehavior?.mode).toBe("explicit");
		const cache = result.options.find((o) => o.strategy === "enable_prompt_cache");
		expect(cache?.viable).toBe(true);
		expect(cache?.costPerTurnUsd).toBeDefined();
		expect(cache?.savingsPerTurnUsd).toBeDefined();
		expect(cache!.savingsPerTurnUsd!).toBeGreaterThan(0);
	});

	it("marks prompt cache as not viable when the provider has none", () => {
		const result = computeContextStrategy({
			model: model({ provider: "groq", pricing: groqPricing }),
			currentTokens: 50_000,
		});
		const cache = result.options.find((o) => o.strategy === "enable_prompt_cache");
		expect(cache?.viable).toBe(false);
		expect(cache?.notes).toMatch(/no documented prompt cache/i);
	});

	it("flags the long-context tier when tokens cross the threshold", () => {
		const result = computeContextStrategy({
			model: model({ provider: "google", pricing: geminiPricing, contextWindow: 1_000_000 }),
			currentTokens: 200_000,
		});
		expect(result.situation.inLongContextTier).toBe(true);
		const tier = result.options.find((o) => o.strategy === "switch_to_long_context_tier");
		expect(tier?.viable).toBe(true);
		expect(tier?.notes).toMatch(/already in long-context tier/i);
	});

	it("does not surface a long-context tier option when the model lacks tiered pricing", () => {
		const result = computeContextStrategy({
			model: model({ pricing: claudePricing }),
			currentTokens: 50_000,
		});
		const tier = result.options.find((o) => o.strategy === "switch_to_long_context_tier");
		expect(tier?.viable).toBe(false);
	});

	it("recommends compaction when headroom is critically low", () => {
		const result = computeContextStrategy({
			model: model({ pricing: claudePricing }),
			currentTokens: 195_000,
			candidateAlternatives: [
				model({ id: "claude-haiku-4-5", pricing: { inputPerMillion: 0.8, outputPerMillion: 4 } }),
			],
		});
		expect(result.situation.headroomPercent).toBeLessThan(10);
		expect(result.recommended).toBe("compact_and_continue");
	});

	it("recommends a cheaper switch when an alternative would save money", () => {
		const result = computeContextStrategy({
			model: model({ pricing: claudePricing }),
			currentTokens: 50_000,
			candidateAlternatives: [
				model({ id: "kimi-k2", provider: "moonshot", pricing: { inputPerMillion: 0.15, outputPerMillion: 2.5 } }),
			],
		});
		const switchOpt = result.options.find((o) => o.strategy === "switch_model");
		expect(switchOpt?.viable).toBe(true);
		expect(switchOpt!.savingsPerTurnUsd!).toBeGreaterThan(0);
	});

	it("returns 'continue' notes signalling no pressure when headroom is comfortable", () => {
		const result = computeContextStrategy({
			model: model({ pricing: claudePricing }),
			currentTokens: 10_000,
		});
		const cont = result.options.find((o) => o.strategy === "continue");
		expect(cont?.viable).toBe(true);
		expect(cont?.notes).toMatch(/no pressure/i);
	});

	it("surfaces batch offload when the model publishes batch pricing", () => {
		const result = computeContextStrategy({
			model: model({
				pricing: { ...claudePricing, batchInputPerMillion: 1.5, batchOutputPerMillion: 7.5 },
			}),
			currentTokens: 100_000,
		});
		const batch = result.options.find((o) => o.strategy === "batch_offload");
		expect(batch?.viable).toBe(true);
		expect(batch!.savingsPerTurnUsd!).toBeGreaterThan(0);
	});

	it("marks batch offload as not viable when batch pricing is absent", () => {
		const result = computeContextStrategy({
			model: model({ pricing: claudePricing }),
			currentTokens: 50_000,
		});
		const batch = result.options.find((o) => o.strategy === "batch_offload");
		expect(batch?.viable).toBe(false);
	});

	it("reports passthrough cache behavior for gateway providers", () => {
		const result = computeContextStrategy({
			model: model({ provider: "vercel", pricing: claudePricing }),
			currentTokens: 10_000,
		});
		expect(result.cacheBehavior?.mode).toBe("passthrough");
		const cache = result.options.find((o) => o.strategy === "enable_prompt_cache");
		expect(cache?.viable).toBe(true);
		expect(cache?.notes).toMatch(/forwards|gateway|underlying/i);
	});
});
