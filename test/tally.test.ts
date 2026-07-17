/**
 * Tests for the zero-dependency token usage + cost tally primitives.
 */

import { describe, expect, it } from "vitest";
import { estimateUsdCost, normalizeTokenUsage, tallyCosts } from "../src/tally.js";
import type { ModelPricing } from "../src/types.js";

const pricing: ModelPricing = {
	inputPerMillion: 3,
	outputPerMillion: 15,
	cacheReadPerMillion: 0.3,
	cacheWritePerMillion: 3.75,
	reasoningOutputPerMillion: 60,
};

describe("normalizeTokenUsage", () => {
	it("normalizes OpenAI-style snake_case usage", () => {
		expect(normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 250 })).toEqual({
			inputTokens: 1000,
			outputTokens: 250,
			totalTokens: 1250,
		});
	});

	it("normalizes Anthropic-style usage including cache fields", () => {
		const usage = normalizeTokenUsage({
			input_tokens: 500,
			output_tokens: 100,
			cache_read_input_tokens: 2000,
			cache_creation_input_tokens: 300,
		});
		expect(usage).toEqual({
			inputTokens: 500,
			outputTokens: 100,
			cachedInputTokens: 2000,
			cacheWriteTokens: 300,
			totalTokens: 2900,
		});
	});

	it("reads nested reasoning tokens (completion_tokens_details.reasoning_tokens)", () => {
		const usage = normalizeTokenUsage({
			prompt_tokens: 10,
			completion_tokens: 20,
			completion_tokens_details: { reasoning_tokens: 5 },
		});
		expect(usage?.reasoningTokens).toBe(5);
	});

	it("accepts already-canonical camelCase usage", () => {
		expect(normalizeTokenUsage({ inputTokens: 10, outputTokens: 20 })).toEqual({
			inputTokens: 10,
			outputTokens: 20,
			totalTokens: 30,
		});
	});

	it("returns null for non-usage objects", () => {
		expect(normalizeTokenUsage({ foo: "bar" })).toBeNull();
		expect(normalizeTokenUsage(null)).toBeNull();
		expect(normalizeTokenUsage(undefined)).toBeNull();
	});

	it("accepts cache-write-only usage (zero input/output)", () => {
		const usage = normalizeTokenUsage({
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 500,
		});
		expect(usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 500,
			totalTokens: 500,
		});
	});

	it("accepts reasoning-only usage (zero input/output)", () => {
		const usage = normalizeTokenUsage({
			prompt_tokens: 0,
			completion_tokens: 0,
			completion_tokens_details: { reasoning_tokens: 100 },
		});
		expect(usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 100,
			totalTokens: 100,
		});
	});
});

describe("estimateUsdCost", () => {
	it("prices input and output tokens against the model rate", () => {
		const cost = estimateUsdCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing);
		expect(cost.inputUsd).toBe(3);
		expect(cost.outputUsd).toBe(15);
		expect(cost.totalUsd).toBe(18);
	});

	it("prices cache read/write and reasoning tokens when present", () => {
		const cost = estimateUsdCost(
			{
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 1_000_000,
				cacheWriteTokens: 1_000_000,
				reasoningTokens: 1_000_000,
			},
			pricing,
		);
		expect(cost.cachedInputUsd).toBe(0.3);
		expect(cost.cacheWriteUsd).toBe(3.75);
		expect(cost.reasoningUsd).toBe(60);
	});

	it("falls back reasoning tokens to the output rate when no reasoning rate is set", () => {
		const cost = estimateUsdCost(
			{ inputTokens: 0, outputTokens: 0, reasoningTokens: 1_000_000 },
			{ inputPerMillion: 1, outputPerMillion: 10 },
		);
		expect(cost.reasoningUsd).toBe(10);
	});
});

describe("tallyCosts", () => {
	it("aggregates calls by model and sums totals", () => {
		const result = tallyCosts(
			[
				{ modelId: "sonnet", usage: { inputTokens: 1_000_000, outputTokens: 0 } },
				{ modelId: "sonnet", usage: { inputTokens: 1_000_000, outputTokens: 0 } },
				{ modelId: "haiku", usage: { inputTokens: 1_000_000, outputTokens: 0 } },
			],
			(modelId) => (modelId === "sonnet" ? pricing : { inputPerMillion: 1, outputPerMillion: 5 }),
		);

		expect(result.calls).toBe(3);
		expect(result.byModel).toHaveLength(2);
		const sonnet = result.byModel.find((m) => m.modelId === "sonnet");
		expect(sonnet?.calls).toBe(2);
		expect(sonnet?.inputUsd).toBe(6);
		expect(result.totalUsd).toBeCloseTo(6 + 1, 10);
	});

	it("excludes unpriced models from totals and lists them separately", () => {
		const result = tallyCosts([{ modelId: "mystery-model", usage: { inputTokens: 100, outputTokens: 100 } }], () => null);
		expect(result.unpriced).toEqual(["mystery-model"]);
		expect(result.byModel).toHaveLength(0);
		expect(result.totalUsd).toBe(0);
	});
});
