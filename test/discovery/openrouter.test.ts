/**
 * Tests for the OpenRouterDiscoverer class.
 *
 * Validates model discovery, capability inference, pricing conversion,
 * filtering of unavailable models, and error handling against the
 * OpenRouter `/api/v1/models` endpoint.
 */

import { afterEach, describe, expect, it } from "vitest";
import { OpenRouterDiscoverer } from "../../src/discovery/openrouter.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new OpenRouterDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "sk-or-test-key",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

/** Mock model: GPT-4o — chat with vision, text+image modality */
const gpt4o = {
	id: "openai/gpt-4o",
	name: "OpenAI: GPT-4o",
	description: "GPT-4o is a multimodal flagship model.",
	pricing: { prompt: "0.0000025", completion: "0.00001" },
	context_length: 128000,
	top_provider: { max_completion_tokens: 16384, is_moderated: true },
	architecture: { modality: "text+image->text", tokenizer: "GPT", instruct_type: null },
};

/** Mock model: Claude Sonnet 4 — modern chat, text->text */
const claudeSonnet = {
	id: "anthropic/claude-sonnet-4-6",
	name: "Anthropic: Claude Sonnet 4",
	description: "Claude Sonnet 4 by Anthropic.",
	pricing: { prompt: "0.000003", completion: "0.000015" },
	context_length: 200000,
	top_provider: { max_completion_tokens: 8192, is_moderated: false },
	architecture: { modality: "text->text", tokenizer: "Claude", instruct_type: null },
};

/** Mock model: text-embedding-3-small — embedding model */
const embedding = {
	id: "openai/text-embedding-3-small",
	name: "OpenAI: Text Embedding 3 Small",
	description: "Small embedding model.",
	pricing: { prompt: "0.00000002", completion: "0" },
	context_length: 8191,
	top_provider: { max_completion_tokens: null, is_moderated: false },
	architecture: { modality: "text->embedding", tokenizer: "GPT", instruct_type: null },
};

/** Mock model: delisted — pricing.prompt is "-1", should be filtered out */
const delistedModel = {
	id: "defunct/old-model",
	name: "Defunct: Old Model",
	description: "No longer available.",
	pricing: { prompt: "-1", completion: "-1" },
	context_length: 4096,
	top_provider: { max_completion_tokens: 1024, is_moderated: false },
	architecture: { modality: "text->text", tokenizer: "Other", instruct_type: null },
};

/** Mock model: image-only modality */
const imageModel = {
	id: "stabilityai/sdxl",
	name: "Stability AI: SDXL",
	description: "Image generation model.",
	pricing: { prompt: "0", completion: "0" },
	context_length: 0,
	top_provider: { max_completion_tokens: null, is_moderated: false },
	architecture: { modality: "image", tokenizer: "Other", instruct_type: null },
};

/** Mock model: sunsetting — future `expiration_date` should map to "deprecated". */
const deprecatedModel = {
	id: "openai/gpt-3.5-turbo-0613",
	name: "OpenAI: GPT-3.5 Turbo (0613)",
	description: "Legacy snapshot, sunsetting.",
	pricing: { prompt: "0.0000015", completion: "0.000002" },
	context_length: 4096,
	top_provider: { max_completion_tokens: 4096, is_moderated: false },
	architecture: { modality: "text->text", tokenizer: "GPT", instruct_type: null },
	expiration_date: "2099-12-31T00:00:00.000Z",
};

/** Mock model: sunset already passed — past `expiration_date` → "retired". */
const retiredModel = {
	id: "openai/gpt-3.5-turbo-0301",
	name: "OpenAI: GPT-3.5 Turbo (0301)",
	description: "Retired snapshot.",
	pricing: { prompt: "0.0000015", completion: "0.000002" },
	context_length: 4096,
	top_provider: { max_completion_tokens: 4096, is_moderated: false },
	architecture: { modality: "text->text", tokenizer: "GPT", instruct_type: null },
	expiration_date: "2020-01-01T00:00:00.000Z",
};

const mockModelsResponse = {
	data: [gpt4o, claudeSonnet, embedding, delistedModel, imageModel],
};

const API_URL = "https://openrouter.ai/api/v1/models";

afterEach(() => {
	restoreFetch();
});

describe("OpenRouterDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("openrouter");
		expect(discoverer.providerName).toBe("OpenRouter");
		expect(discoverer.baseUrl).toBe("https://openrouter.ai");
	});

	it("should discover models without an API key (optional auth)", async () => {
		mockFetch({ [API_URL]: { status: 200, body: mockModelsResponse } });

		const cards = await discoverer.discover(noCredential);

		// Should still return results (delisted model filtered out)
		expect(cards.length).toBeGreaterThan(0);
	});

	it("should send Bearer auth header when API key is provided", async () => {
		let capturedHeaders: Record<string, string> | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = Object.fromEntries(
				Object.entries(init?.headers ?? {}).map(([k, v]) => [k, v]),
			);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => ({ data: [] }),
				text: async () => JSON.stringify({ data: [] }),
			} as Response;
		}) as typeof globalThis.fetch;

		await discoverer.discover(validCredential);
		globalThis.fetch = originalFetch;

		expect(capturedHeaders).toBeDefined();
		expect(capturedHeaders!.Authorization).toBe("Bearer sk-or-test-key");
	});

	it("should filter out unavailable models (pricing.prompt === '-1')", async () => {
		mockFetch({ [API_URL]: { status: 200, body: mockModelsResponse } });

		const cards = await discoverer.discover(noCredential);

		const delisted = cards.find((c) => c.id === "defunct/old-model");
		expect(delisted).toBeUndefined();
	});

	it("should discover models and create correct ModelCards", async () => {
		mockFetch({ [API_URL]: { status: 200, body: mockModelsResponse } });

		const cards = await discoverer.discover(noCredential);

		// 5 mocks minus 1 delisted = 4 cards
		expect(cards).toHaveLength(4);

		// GPT-4o — chat + vision + function_calling + code + nlu
		const gpt = cards.find((c) => c.id === "openai/gpt-4o");
		expect(gpt).toBeDefined();
		expect(gpt!.name).toBe("OpenAI: GPT-4o");
		expect(gpt!.provider).toBe("openrouter");
		expect(gpt!.mode).toBe("chat");
		expect(gpt!.capabilities).toContain("chat");
		expect(gpt!.capabilities).toContain("vision");
		expect(gpt!.capabilities).toContain("function_calling");
		expect(gpt!.capabilities).toContain("code");
		expect(gpt!.capabilities).toContain("nlu");
		expect(gpt!.source).toBe("api");

		// Claude Sonnet 4 — chat + function_calling (modern model)
		const claude = cards.find((c) => c.id === "anthropic/claude-sonnet-4-6");
		expect(claude).toBeDefined();
		expect(claude!.name).toBe("Anthropic: Claude Sonnet 4");
		expect(claude!.mode).toBe("chat");
		expect(claude!.capabilities).toContain("chat");
		expect(claude!.capabilities).toContain("function_calling");
		expect(claude!.capabilities).not.toContain("vision");

		// Embedding model
		const embed = cards.find((c) => c.id === "openai/text-embedding-3-small");
		expect(embed).toBeDefined();
		expect(embed!.mode).toBe("embedding");
		expect(embed!.capabilities).toContain("embedding");
		expect(embed!.capabilities).not.toContain("chat");
	});

	it("should infer 'chat' mode for text->text models", async () => {
		mockFetch({
			[API_URL]: { status: 200, body: { data: [claudeSonnet] } },
		});

		const cards = await discoverer.discover(noCredential);
		expect(cards[0].mode).toBe("chat");
	});

	it("should infer 'embedding' mode for models with 'embed' in id", async () => {
		mockFetch({
			[API_URL]: { status: 200, body: { data: [embedding] } },
		});

		const cards = await discoverer.discover(noCredential);
		expect(cards[0].mode).toBe("embedding");
		expect(cards[0].capabilities).toEqual(["embedding"]);
	});

	it("should infer 'image' mode for image-only modality", async () => {
		mockFetch({
			[API_URL]: { status: 200, body: { data: [imageModel] } },
		});

		const cards = await discoverer.discover(noCredential);
		expect(cards[0].mode).toBe("image");
		expect(cards[0].capabilities).toEqual(["image_generation"]);
	});

	it("should parse pricing: per-token strings to per-million numbers", async () => {
		mockFetch({ [API_URL]: { status: 200, body: { data: [gpt4o] } } });

		const cards = await discoverer.discover(noCredential);
		const card = cards[0];

		expect(card.pricing).toBeDefined();
		// prompt = "0.0000025" * 1_000_000 = 2.5
		expect(card.pricing!.inputPerMillion).toBeCloseTo(2.5);
		// completion = "0.00001" * 1_000_000 = 10
		expect(card.pricing!.outputPerMillion).toBeCloseTo(10);
	});

	it("should infer vision capability from 'text+image' modality", async () => {
		mockFetch({ [API_URL]: { status: 200, body: { data: [gpt4o] } } });

		const cards = await discoverer.discover(noCredential);

		expect(cards[0].capabilities).toContain("vision");
	});

	it("should detect modern chat models and add function_calling, code, nlu", async () => {
		const modernModels = [
			{ ...claudeSonnet, id: "anthropic/claude-3-opus", name: "Claude 3 Opus" },
			{ ...claudeSonnet, id: "google/gemini-pro", name: "Gemini Pro" },
			{ ...claudeSonnet, id: "cohere/command-r-plus", name: "Command R+" },
			{ ...claudeSonnet, id: "meta-llama/llama-3-70b", name: "Llama 3 70B" },
			{ ...claudeSonnet, id: "mistralai/mistral-large", name: "Mistral Large" },
			{ ...claudeSonnet, id: "deepseek/deepseek-v2", name: "DeepSeek V2" },
		];

		mockFetch({
			[API_URL]: { status: 200, body: { data: modernModels } },
		});

		const cards = await discoverer.discover(noCredential);

		for (const card of cards) {
			expect(card.capabilities).toContain("function_calling");
			expect(card.capabilities).toContain("code");
			expect(card.capabilities).toContain("nlu");
		}
	});

	it("should extract contextWindow and maxOutputTokens from API response", async () => {
		mockFetch({ [API_URL]: { status: 200, body: { data: [gpt4o] } } });

		const cards = await discoverer.discover(noCredential);
		const card = cards[0];

		expect(card.contextWindow).toBe(128000);
		expect(card.maxOutputTokens).toBe(16384);
	});

	it("should default maxOutputTokens to 0 when top_provider.max_completion_tokens is null", async () => {
		mockFetch({ [API_URL]: { status: 200, body: { data: [embedding] } } });

		const cards = await discoverer.discover(noCredential);

		expect(cards[0].maxOutputTokens).toBe(0);
	});

	it("should set correct default fields on ModelCard", async () => {
		mockFetch({ [API_URL]: { status: 200, body: { data: [claudeSonnet] } } });

		const cards = await discoverer.discover(noCredential);
		const card = cards[0];

		expect(card.aliases).toEqual([]);
		expect(card.discoveredAt).toBeGreaterThan(0);
		expect(card.source).toBe("api");
	});

	it("should throw on API error", async () => {
		mockFetch({
			[API_URL]: {
				status: 429,
				body: { error: { message: "Rate limit exceeded" } },
			},
		});

		await expect(discoverer.discover(noCredential)).rejects.toThrow("OpenRouter API error: 429");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(noCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	describe("lifecycle (deprecation signals)", () => {
		it("should mark a model with a future expiration_date as deprecated", async () => {
			mockFetch({
				[API_URL]: { status: 200, body: { data: [deprecatedModel] } },
			});

			const cards = await discoverer.discover(noCredential);
			const card = cards[0];

			expect(card.status).toBe("deprecated");
			expect(card.deprecationDate).toBe("2099-12-31T00:00:00.000Z");
			// OpenRouter publishes no successor — replacedBy must stay unset.
			expect(card.replacedBy).toBeUndefined();
		});

		it("should mark a model whose expiration_date has passed as retired", async () => {
			mockFetch({
				[API_URL]: { status: 200, body: { data: [retiredModel] } },
			});

			const cards = await discoverer.discover(noCredential);
			const card = cards[0];

			expect(card.status).toBe("retired");
			expect(card.deprecationDate).toBe("2020-01-01T00:00:00.000Z");
		});

		it("should leave normal models active (no expiration_date)", async () => {
			mockFetch({ [API_URL]: { status: 200, body: { data: [gpt4o, claudeSonnet] } } });

			const cards = await discoverer.discover(noCredential);

			for (const card of cards) {
				// status undefined === active for downstream consumers; a null
				// expiration_date must not invent a deprecationDate either.
				expect(card.status).toBeUndefined();
				expect(card.deprecationDate).toBeUndefined();
				expect(card.replacedBy).toBeUndefined();
			}
		});

		it("should not invent a deprecationDate when expiration_date is null", async () => {
			const explicitlyNull = { ...claudeSonnet, expiration_date: null };
			mockFetch({
				[API_URL]: { status: 200, body: { data: [explicitlyNull] } },
			});

			const cards = await discoverer.discover(noCredential);
			expect(cards[0].status).toBeUndefined();
			expect(cards[0].deprecationDate).toBeUndefined();
		});
	});

	describe("originProvider via canonical normalizer", () => {
		it("should derive originProvider from the canonical prefix map", async () => {
			const models = [
				{ ...claudeSonnet, id: "anthropic/claude-sonnet-4-6" },
				{ ...claudeSonnet, id: "openai/gpt-4o" },
				{ ...claudeSonnet, id: "google/gemini-2.5-pro" },
				{ ...claudeSonnet, id: "meta-llama/llama-3.3-70b-instruct" },
				{ ...claudeSonnet, id: "mistralai/mistral-large" },
				{ ...claudeSonnet, id: "deepseek/deepseek-v2" },
				{ ...claudeSonnet, id: "qwen/qwen-2.5-72b" },
				{ ...claudeSonnet, id: "cohere/command-r-plus" },
			];

			mockFetch({
				[API_URL]: { status: 200, body: { data: models } },
			});

			const cards = await discoverer.discover(noCredential);
			const byId = new Map(cards.map((c) => [c.id, c.originProvider]));

			expect(byId.get("anthropic/claude-sonnet-4-6")).toBe("anthropic");
			expect(byId.get("openai/gpt-4o")).toBe("openai");
			expect(byId.get("google/gemini-2.5-pro")).toBe("google");
			// meta-llama → canonical slug "meta" (proves the local map is gone)
			expect(byId.get("meta-llama/llama-3.3-70b-instruct")).toBe("meta");
			expect(byId.get("mistralai/mistral-large")).toBe("mistral");
			expect(byId.get("deepseek/deepseek-v2")).toBe("deepseek");
			expect(byId.get("qwen/qwen-2.5-72b")).toBe("qwen");
			expect(byId.get("cohere/command-r-plus")).toBe("cohere");
		});

		it("should fall back to the raw vendor prefix for unknown namespaces", async () => {
			const models = [
				// Neither the `stabilityai` prefix nor the `sdxl` bare name are
				// known to the canonical normalizer → raw prefix must survive.
				{ ...claudeSonnet, id: "stabilityai/sdxl" },
				// Same for `microsoft` / `phi-3` — no prefix or pattern match.
				{ ...claudeSonnet, id: "microsoft/phi-3-mini" },
			];

			mockFetch({
				[API_URL]: { status: 200, body: { data: models } },
			});

			const cards = await discoverer.discover(noCredential);
			const byId = new Map(cards.map((c) => [c.id, c.originProvider]));

			// Unknown vendors keep their raw prefix rather than collapsing to
			// the serving provider ("openrouter").
			expect(byId.get("stabilityai/sdxl")).toBe("stabilityai");
			expect(byId.get("microsoft/phi-3-mini")).toBe("microsoft");
		});

		it("should resolve origin via canonical bare-name patterns (not just prefixes)", async () => {
			// Routing through the canonical normalizer improves on the old local
			// map: `nvidia` is not a known prefix, but the canonical helper's
			// bare-name pattern `/^llama/i` correctly attributes the model to
			// its true creator (meta) instead of the hosting vendor.
			const models = [{ ...claudeSonnet, id: "nvidia/llama-3.1-nemotron-70b-instruct" }];

			mockFetch({
				[API_URL]: { status: 200, body: { data: models } },
			});

			const cards = await discoverer.discover(noCredential);
			expect(cards[0].originProvider).toBe("meta");
		});
	});
});
