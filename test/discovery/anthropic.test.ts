import { afterEach, describe, expect, it } from "vitest";
import { AnthropicDiscoverer } from "../../src/discovery/anthropic.js";
import type { CredentialResult } from "../../src/types.js";
import { resetLiteLLMCatalogCache } from "../../src/enrichment/litellm-catalog.js";
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

		expect(cards).toHaveLength(3);

		// Claude Sonnet 4 — modern model with vision
		const sonnet = cards.find((c) => c.id === "claude-sonnet-4-20250514");
		expect(sonnet).toBeDefined();
		expect(sonnet!.name).toBe("Claude Sonnet 4");
		expect(sonnet!.provider).toBe("anthropic");
		expect(sonnet!.mode).toBe("chat");
		expect(sonnet!.capabilities).toContain("chat");
		expect(sonnet!.capabilities).toContain("code");
		expect(sonnet!.capabilities).toContain("function_calling");
		expect(sonnet!.source).toBe("api");

		// Claude 3.5 Haiku — has vision
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

		// Mock both pages — the mock matches by URL prefix
		let callCount = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			callCount++;
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
		expect(callCount).toBe(2);
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
});
