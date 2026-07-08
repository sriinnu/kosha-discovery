import { afterEach, describe, expect, it } from "vitest";
import { AnthropicDiscoverer } from "../../src/discovery/anthropic.js";
import { resetLiteLLMCatalogCache } from "../../src/enrichment/litellm-catalog.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchError, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new AnthropicDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "sk-ant-test-key",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{
			id: "claude-sonnet-4-20250514",
			display_name: "Claude Sonnet 4",
			created_at: "2025-05-14T00:00:00Z",
			type: "model",
		},
		{
			id: "claude-opus-4-6",
			display_name: "Claude Opus 4.6",
			created_at: "2025-09-18T00:00:00Z",
			type: "model",
		},
		{
			id: "claude-haiku-4-5-20251001",
			display_name: "Claude Haiku 4.5",
			created_at: "2025-10-01T00:00:00Z",
			type: "model",
		},
		{
			id: "claude-3-5-haiku-20241022",
			display_name: "Claude 3.5 Haiku",
			created_at: "2024-10-22T00:00:00Z",
			type: "model",
		},
		{
			id: "claude-2.1",
			display_name: "Claude 2.1",
			created_at: "2023-11-21T00:00:00Z",
			type: "model",
		},
	],
	has_more: false,
	first_id: "claude-sonnet-4-20250514",
	last_id: "claude-2.1",
};

afterEach(() => {
	restoreFetch();
	resetLiteLLMCatalogCache();
});

describe("AnthropicDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("anthropic");
		expect(discoverer.providerName).toBe("Anthropic");
		expect(discoverer.baseUrl).toBe("https://api.anthropic.com");
	});

	it("returns LiteLLM-seeded models when no API key is provided", async () => {
		mockFetch({
			"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json": {
				status: 200,
				body: {
					"claude-opus-4-7": {
						litellm_provider: "anthropic",
						mode: "chat",
						max_input_tokens: 1_000_000,
						max_output_tokens: 64_000,
						input_cost_per_token: 0.000005,
						output_cost_per_token: 0.000025,
						supports_vision: true,
						supports_function_calling: true,
					},
				},
			},
		});

		const result = await discoverer.discover(noCredential);
		expect(result.length).toBeGreaterThan(0);
		expect(result.some((m) => m.id === "claude-opus-4-7")).toBe(true);
		expect(result.every((m) => m.provider === "anthropic")).toBe(true);
		expect(result.every((m) => m.source === "litellm")).toBe(true);
	});

	it("falls back to curated static list when LiteLLM catalog is unreachable", async () => {
		mockFetchError(new Error("network unreachable"));
		const result = await discoverer.discover(noCredential);
		expect(result.length).toBeGreaterThan(0);
		expect(result.some((m) => m.id === "claude-sonnet-4-6")).toBe(true);
		expect(result.every((m) => m.provider === "anthropic")).toBe(true);
		expect(result.every((m) => m.source === "manual")).toBe(true);
	});

	it("should discover models from API and create correct ModelCards", async () => {
		mockFetch({
			"https://api.anthropic.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		expect(cards).toHaveLength(5);

		// Claude Sonnet 4 — modern family-first model with vision
		const sonnet = cards.find((c) => c.id === "claude-sonnet-4-20250514");
		expect(sonnet).toBeDefined();
		expect(sonnet!.name).toBe("Claude Sonnet 4");
		expect(sonnet!.provider).toBe("anthropic");
		expect(sonnet!.mode).toBe("chat");
		expect(sonnet!.capabilities).toContain("chat");
		expect(sonnet!.capabilities).toContain("code");
		expect(sonnet!.capabilities).toContain("function_calling");
		expect(sonnet!.capabilities).toContain("vision");
		expect(sonnet!.source).toBe("api");

		// Claude Opus 4.6 — family-first ID, must carry vision
		const opus = cards.find((c) => c.id === "claude-opus-4-6");
		expect(opus).toBeDefined();
		expect(opus!.capabilities).toContain("vision");

		// Claude Haiku 4.5 — family-first ID with date suffix, must carry vision
		const haiku4 = cards.find((c) => c.id === "claude-haiku-4-5-20251001");
		expect(haiku4).toBeDefined();
		expect(haiku4!.capabilities).toContain("vision");

		// Claude 3.5 Haiku — legacy version-first 3.x still matches
		const haiku = cards.find((c) => c.id === "claude-3-5-haiku-20241022");
		expect(haiku).toBeDefined();
		expect(haiku!.name).toBe("Claude 3.5 Haiku");
		expect(haiku!.capabilities).toContain("vision");

		// Claude 2.1 — NO vision (pre-Claude-3)
		const claude2 = cards.find((c) => c.id === "claude-2.1");
		expect(claude2).toBeDefined();
		expect(claude2!.name).toBe("Claude 2.1");
		expect(claude2!.capabilities).not.toContain("vision");
		expect(claude2!.capabilities).toContain("chat");
	});

	it("should handle pagination", async () => {
		const page1 = {
			data: [
				{
					id: "claude-sonnet-4-20250514",
					display_name: "Claude Sonnet 4",
					created_at: "2025-05-14T00:00:00Z",
					type: "model",
				},
			],
			has_more: true,
			first_id: "claude-sonnet-4-20250514",
			last_id: "claude-sonnet-4-20250514",
		};

		const page2 = {
			data: [
				{
					id: "claude-3-5-haiku-20241022",
					display_name: "Claude 3.5 Haiku",
					created_at: "2024-10-22T00:00:00Z",
					type: "model",
				},
			],
			has_more: false,
			first_id: "claude-3-5-haiku-20241022",
			last_id: "claude-3-5-haiku-20241022",
		};

		// Mock both pages — the mock matches by URL prefix.
		// Only count fetches against api.anthropic.com so the public-seed
		// merge (which fetches models.dev + LiteLLM and is unrelated to
		// pagination) doesn't inflate the count.
		let apiCallCount = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const isApi = url.startsWith("https://api.anthropic.com/");
			if (isApi) apiCallCount++;
			// Public-seed URLs get an empty 200 — keeps the merge a no-op.
			if (!isApi) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => ({}),
					text: async () => "{}",
				} as Response;
			}
			const body = url.includes("after_id") ? page2 : page1;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => body,
				text: async () => JSON.stringify(body),
			} as Response;
		}) as typeof globalThis.fetch;

		const cards = await discoverer.discover(validCredential);
		globalThis.fetch = originalFetch;

		expect(cards).toHaveLength(2);
		expect(apiCallCount).toBe(2);
	});

	it("should throw on API error", async () => {
		mockFetch({
			"https://api.anthropic.com/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Anthropic API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct default fields on ModelCard", async () => {
		mockFetch({
			"https://api.anthropic.com/v1/models": {
				status: 200,
				body: {
					data: [
						{
							id: "claude-3-opus-20240229",
							display_name: "Claude 3 Opus",
							created_at: "2024-02-29T00:00:00Z",
							type: "model",
						},
					],
					has_more: false,
					first_id: "claude-3-opus-20240229",
					last_id: "claude-3-opus-20240229",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		const card = cards[0];

		expect(card.aliases).toEqual([]);
		expect(card.contextWindow).toBe(0);
		expect(card.maxOutputTokens).toBe(0);
		expect(card.discoveredAt).toBeGreaterThan(0);
		expect(card.source).toBe("api");
	});

	// ── Smart-merge with public seed ─────────────────────────────────────
	// These tests cover the BaseDiscoverer.mergeWithPublicSeed helper, which
	// guards the same-day-stability invariant: kosha must return the same
	// pricing for the same SKU regardless of whether `/v1/models` was
	// reachable that minute. The native API endpoint returns no pricing,
	// so we lift it from the seed when the API stub has none.

	it("smart-merge: lifts seed pricing onto API stub when API has no pricing", async () => {
		// API returns claude-opus-4-7 with no pricing. Seed (LiteLLM) has $5/$25.
		// Smart-merge: API entry inherits seed pricing.
		mockFetch({
			"https://api.anthropic.com/v1/models": {
				status: 200,
				body: {
					data: [
						{
							id: "claude-opus-4-7",
							display_name: "Claude Opus 4.7",
							created_at: "2026-04-01T00:00:00Z",
							type: "model",
						},
					],
					has_more: false,
					first_id: "claude-opus-4-7",
					last_id: "claude-opus-4-7",
				},
			},
			"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json": {
				status: 200,
				body: {
					"claude-opus-4-7": {
						litellm_provider: "anthropic",
						mode: "chat",
						max_input_tokens: 200_000,
						max_output_tokens: 64_000,
						input_cost_per_token: 0.000005,
						output_cost_per_token: 0.000025,
					},
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		const opus = cards.find((c) => c.id === "claude-opus-4-7");
		expect(opus).toBeDefined();
		expect(opus!.source).toBe("api"); // identity still from API
		expect(opus!.pricing?.inputPerMillion).toBeCloseTo(5, 5);
		expect(opus!.pricing?.outputPerMillion).toBeCloseTo(25, 5);
	});

	it("smart-merge: keeps seed-only models as filler", async () => {
		// API only returns sonnet. Seed has both sonnet and a preview tier.
		// Preview tier survives as filler so consumers can still resolve it.
		mockFetch({
			"https://api.anthropic.com/v1/models": {
				status: 200,
				body: {
					data: [
						{
							id: "claude-sonnet-4-6",
							display_name: "Claude Sonnet 4.6",
							created_at: "2026-01-01T00:00:00Z",
							type: "model",
						},
					],
					has_more: false,
					first_id: "claude-sonnet-4-6",
					last_id: "claude-sonnet-4-6",
				},
			},
			"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json": {
				status: 200,
				body: {
					"claude-sonnet-4-6": {
						litellm_provider: "anthropic",
						mode: "chat",
						max_input_tokens: 200_000,
						max_output_tokens: 64_000,
						input_cost_per_token: 0.000003,
						output_cost_per_token: 0.000015,
					},
					"claude-opus-4-7-preview": {
						litellm_provider: "anthropic",
						mode: "chat",
						max_input_tokens: 200_000,
						max_output_tokens: 64_000,
						input_cost_per_token: 0.000005,
						output_cost_per_token: 0.000025,
					},
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards.some((c) => c.id === "claude-sonnet-4-6")).toBe(true);
		expect(cards.some((c) => c.id === "claude-opus-4-7-preview")).toBe(true);
	});
});
