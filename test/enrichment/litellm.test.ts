import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiteLLMEnricher } from "../../src/enrichment/litellm.js";
import type { ModelCard } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Sample litellm data
// ---------------------------------------------------------------------------

const LITELLM_DATA: Record<string, any> = {
	"claude-sonnet-4-20250514": {
		max_tokens: 16384,
		max_input_tokens: 200000,
		max_output_tokens: 16384,
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cache_read_input_token_cost: 0.0000003,
		cache_creation_input_token_cost: 0.00000375,
		litellm_provider: "anthropic",
		mode: "chat",
		supports_function_calling: true,
		supports_vision: true,
		supports_prompt_caching: true,
	},
	"openai/gpt-4o": {
		max_tokens: 16384,
		max_input_tokens: 128000,
		max_output_tokens: 16384,
		input_cost_per_token: 0.0000025,
		output_cost_per_token: 0.00001,
		litellm_provider: "openai",
		mode: "chat",
		supports_function_calling: true,
		supports_vision: true,
	},
	"text-embedding-3-small": {
		max_tokens: 8191,
		max_input_tokens: 8191,
		input_cost_per_token: 0.00000002,
		output_cost_per_token: 0,
		litellm_provider: "openai",
		mode: "embedding",
		output_vector_size: 1536,
	},
	"dall-e-3": {
		litellm_provider: "openai",
		mode: "image_generation",
		input_cost_per_token: 0,
		output_cost_per_token: 0,
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelCard> = {}): ModelCard {
	return {
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet 4",
		provider: "anthropic",
		mode: "chat",
		capabilities: [],
		contextWindow: 0,
		maxOutputTokens: 0,
		aliases: [],
		discoveredAt: Date.now(),
		source: "api",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiteLLMEnricher", () => {
	let enricher: LiteLLMEnricher;

	beforeEach(() => {
		enricher = new LiteLLMEnricher();

		// Mock fetch to return our sample data
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(LITELLM_DATA), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------------------
	// Pricing enrichment
	// -----------------------------------------------------------------------

	describe("pricing enrichment", () => {
		it("fills pricing from litellm data (per-token -> per-million conversion)", async () => {
			const models = [makeModel()];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.pricing).toBeDefined();
			expect(enriched.pricing!.inputPerMillion).toBe(3); // 0.000003 * 1_000_000
			expect(enriched.pricing!.outputPerMillion).toBe(15); // 0.000015 * 1_000_000
		});

		it("fills cache pricing when available", async () => {
			const models = [makeModel()];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.pricing!.cacheReadPerMillion).toBe(0.3); // 0.0000003 * 1_000_000
			expect(enriched.pricing!.cacheWritePerMillion).toBe(3.75); // 0.00000375 * 1_000_000
		});

		it("does not overwrite existing pricing", async () => {
			const existingPricing = {
				inputPerMillion: 99,
				outputPerMillion: 199,
			};
			const models = [makeModel({ pricing: existingPricing })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.pricing!.inputPerMillion).toBe(99);
			expect(enriched.pricing!.outputPerMillion).toBe(199);
		});
	});

	// -----------------------------------------------------------------------
	// Context window enrichment
	// -----------------------------------------------------------------------

	describe("context window enrichment", () => {
		it("fills contextWindow from litellm max_input_tokens", async () => {
			const models = [makeModel({ contextWindow: 0 })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.contextWindow).toBe(200000);
		});

		it("does not overwrite existing contextWindow", async () => {
			const models = [makeModel({ contextWindow: 100000 })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.contextWindow).toBe(100000);
		});
	});

	// -----------------------------------------------------------------------
	// Max output tokens enrichment
	// -----------------------------------------------------------------------

	describe("max output tokens enrichment", () => {
		it("fills maxOutputTokens from litellm data", async () => {
			const models = [makeModel({ maxOutputTokens: 0 })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.maxOutputTokens).toBe(16384);
		});

		it("does not overwrite existing maxOutputTokens", async () => {
			const models = [makeModel({ maxOutputTokens: 4096 })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.maxOutputTokens).toBe(4096);
		});
	});

	// -----------------------------------------------------------------------
	// Capability enrichment
	// -----------------------------------------------------------------------

	describe("capability enrichment", () => {
		it("adds vision capability from litellm supports_vision flag", async () => {
			const models = [makeModel({ capabilities: [] })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.capabilities).toContain("vision");
		});

		it("adds function_calling capability", async () => {
			const models = [makeModel({ capabilities: [] })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.capabilities).toContain("function_calling");
		});

		it("adds prompt_caching capability", async () => {
			const models = [makeModel({ capabilities: [] })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.capabilities).toContain("prompt_caching");
		});

		it("does not duplicate existing capabilities", async () => {
			const models = [makeModel({ capabilities: ["vision", "function_calling"] })];
			const [enriched] = await enricher.enrich(models);

			const visionCount = enriched.capabilities.filter((c) => c === "vision").length;
			expect(visionCount).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// Embedding model enrichment
	// -----------------------------------------------------------------------

	describe("embedding model enrichment", () => {
		it("fills dimensions from output_vector_size for embedding models", async () => {
			const models = [
				makeModel({
					id: "text-embedding-3-small",
					name: "Text Embedding 3 Small",
					provider: "openai",
					mode: "chat", // will be corrected to "embedding" by enrichment
				}),
			];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.dimensions).toBe(1536);
		});

		it("corrects mode from chat to embedding when litellm says embedding", async () => {
			const models = [
				makeModel({
					id: "text-embedding-3-small",
					name: "Text Embedding 3 Small",
					provider: "openai",
					mode: "chat",
				}),
			];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.mode).toBe("embedding");
		});
	});

	// -----------------------------------------------------------------------
	// Provider prefix lookup
	// -----------------------------------------------------------------------

	describe("provider prefix lookup", () => {
		it("finds model using {provider}/{id} format", async () => {
			const models = [
				makeModel({
					id: "gpt-4o",
					name: "GPT-4o",
					provider: "openai",
					contextWindow: 0,
					maxOutputTokens: 0,
				}),
			];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.contextWindow).toBe(128000);
			expect(enriched.maxOutputTokens).toBe(16384);
			expect(enriched.pricing).toBeDefined();
			expect(enriched.pricing!.inputPerMillion).toBe(2.5);
		});
	});

	// -----------------------------------------------------------------------
	// Model not in litellm
	// -----------------------------------------------------------------------

	describe("model not in litellm", () => {
		it("returns unchanged model when not found in litellm", async () => {
			const original = makeModel({
				id: "custom-model-xyz",
				name: "Custom Model",
				provider: "custom",
				contextWindow: 4096,
				maxOutputTokens: 2048,
			});
			const models = [original];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.id).toBe("custom-model-xyz");
			expect(enriched.contextWindow).toBe(4096);
			expect(enriched.maxOutputTokens).toBe(2048);
			expect(enriched.pricing).toBeUndefined();
			expect(enriched.capabilities).toEqual([]);
		});

		it("does not mutate the original model", async () => {
			const original = makeModel({ capabilities: ["chat"] });
			const [enriched] = await enricher.enrich([original]);

			// The enriched model should be a new object
			expect(enriched).not.toBe(original);
			// Original capabilities should be unchanged
			expect(original.capabilities).toEqual(["chat"]);
			// Enriched should have additional capabilities
			expect(enriched.capabilities).toContain("chat");
			expect(enriched.capabilities).toContain("vision");
		});
	});

	// -----------------------------------------------------------------------
	// Load behaviour
	// -----------------------------------------------------------------------

	describe("load", () => {
		it("caches data and does not re-fetch", async () => {
			await enricher.load();
			await enricher.load();

			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		});

		it("throws on fetch failure", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValueOnce(
				new Response("Not Found", { status: 404 }),
			);
			const freshEnricher = new LiteLLMEnricher();

			await expect(freshEnricher.load()).rejects.toThrow("Failed to fetch litellm data");
		});
	});

	// -----------------------------------------------------------------------
	// Max input tokens
	// -----------------------------------------------------------------------

	describe("max input tokens", () => {
		it("fills maxInputTokens when missing", async () => {
			const models = [makeModel()];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.maxInputTokens).toBe(200000);
		});

		it("does not overwrite existing maxInputTokens", async () => {
			const models = [makeModel({ maxInputTokens: 50000 })];
			const [enriched] = await enricher.enrich(models);

			expect(enriched.maxInputTokens).toBe(50000);
		});
	});
});
