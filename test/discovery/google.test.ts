import { afterEach, describe, expect, it } from "vitest";
import { GoogleDiscoverer } from "../../src/discovery/google.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new GoogleDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "AIzaSy-test-key-12345",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

/** Mock Google Generative Language API response with representative models. */
const mockModelsResponse = {
	models: [
		{
			name: "models/gemini-2.5-pro",
			displayName: "Gemini 2.5 Pro",
			description: "Google's most capable model for complex tasks.",
			inputTokenLimit: 1048576,
			outputTokenLimit: 65536,
			supportedGenerationMethods: ["generateContent", "countTokens"],
		},
		{
			name: "models/gemini-2.0-flash",
			displayName: "Gemini 2.0 Flash",
			description: "Fast and efficient Gemini model.",
			inputTokenLimit: 1048576,
			outputTokenLimit: 8192,
			supportedGenerationMethods: ["generateContent", "countTokens"],
		},
		{
			name: "models/gemini-embedding-001",
			displayName: "Gemini Embedding 001",
			description: "Text embedding model.",
			inputTokenLimit: 2048,
			outputTokenLimit: 0,
			supportedGenerationMethods: ["embedContent"],
		},
	],
};

afterEach(() => {
	restoreFetch();
});

/** Tests for the Google / Gemini model discoverer. */
describe("GoogleDiscoverer", () => {
	/** Verify provider identity fields are set correctly. */
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("google");
		expect(discoverer.providerName).toBe("Google");
		expect(discoverer.baseUrl).toBe("https://generativelanguage.googleapis.com");
	});

	/** When no API key is present, discover should short-circuit with an empty array. */
	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	/** Verify that a full API response is correctly mapped to ModelCards. */
	it("should discover models from API and create correct ModelCards", async () => {
		mockFetch({
			"https://generativelanguage.googleapis.com/v1beta/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		expect(cards).toHaveLength(3);

		// Gemini 2.5 Pro — chat model with vision + function_calling
		const pro = cards.find((c) => c.id === "gemini-2.5-pro");
		expect(pro).toBeDefined();
		expect(pro!.name).toBe("Gemini 2.5 Pro");
		expect(pro!.provider).toBe("google");
		expect(pro!.mode).toBe("chat");
		expect(pro!.capabilities).toContain("chat");
		expect(pro!.capabilities).toContain("vision");
		expect(pro!.capabilities).toContain("function_calling");
		expect(pro!.capabilities).toContain("code");
		expect(pro!.capabilities).toContain("nlu");
		expect(pro!.contextWindow).toBe(1048576);
		expect(pro!.maxOutputTokens).toBe(65536);
		expect(pro!.source).toBe("api");

		// Gemini 2.0 Flash — chat model with vision + function_calling
		const flash = cards.find((c) => c.id === "gemini-2.0-flash");
		expect(flash).toBeDefined();
		expect(flash!.name).toBe("Gemini 2.0 Flash");
		expect(flash!.capabilities).toContain("vision");
		expect(flash!.capabilities).toContain("function_calling");
		expect(flash!.contextWindow).toBe(1048576);
		expect(flash!.maxOutputTokens).toBe(8192);

		// Gemini Embedding 001 — embedding mode with embedContent method
		const embedding = cards.find((c) => c.id === "gemini-embedding-001");
		expect(embedding).toBeDefined();
		expect(embedding!.name).toBe("Gemini Embedding 001");
		expect(embedding!.mode).toBe("embedding");
		expect(embedding!.capabilities).toEqual(["embedding"]);
	});

	/** Verify "models/" prefix is stripped from all model IDs. */
	it("should strip 'models/' prefix from IDs", async () => {
		mockFetch({
			"https://generativelanguage.googleapis.com/v1beta/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.id).not.toMatch(/^models\//);
		}

		expect(cards.map((c) => c.id)).toEqual([
			"gemini-2.5-pro",
			"gemini-2.0-flash",
			"gemini-embedding-001",
		]);
	});

	/** Verify displayName is used for the card name field. */
	it("should use displayName for the name field", async () => {
		mockFetch({
			"https://generativelanguage.googleapis.com/v1beta/models": {
				status: 200,
				body: {
					models: [
						{
							name: "models/gemini-2.5-pro",
							displayName: "Gemini 2.5 Pro",
							description: "A powerful model.",
							inputTokenLimit: 1048576,
							outputTokenLimit: 65536,
							supportedGenerationMethods: ["generateContent"],
						},
					],
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards[0].name).toBe("Gemini 2.5 Pro");
	});

	/** Verify inputTokenLimit → contextWindow and outputTokenLimit → maxOutputTokens. */
	it("should extract token limits into contextWindow and maxOutputTokens", async () => {
		mockFetch({
			"https://generativelanguage.googleapis.com/v1beta/models": {
				status: 200,
				body: {
					models: [
						{
							name: "models/gemini-2.5-pro",
							displayName: "Gemini 2.5 Pro",
							description: "",
							inputTokenLimit: 1048576,
							outputTokenLimit: 65536,
							supportedGenerationMethods: ["generateContent"],
						},
					],
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards[0].contextWindow).toBe(1048576);
		expect(cards[0].maxOutputTokens).toBe(65536);
	});

	/** Models with "embedContent" in supportedGenerationMethods should be mode=embedding. */
	it("should infer embedding mode when supportedGenerationMethods includes embedContent", async () => {
		mockFetch({
			"https://generativelanguage.googleapis.com/v1beta/models": {
				status: 200,
				body: {
					models: [
						{
							name: "models/text-embedding-004",
							displayName: "Text Embedding 004",
							description: "Embedding model.",
							inputTokenLimit: 2048,
							outputTokenLimit: 0,
							supportedGenerationMethods: ["embedContent"],
						},
					],
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards[0].mode).toBe("embedding");
		expect(cards[0].capabilities).toEqual(["embedding"]);
	});

	/** Pro, Flash, and Ultra models should get vision + function_calling. */
	it("should infer vision and function_calling for pro/flash/ultra models", async () => {
		mockFetch({
			"https://generativelanguage.googleapis.com/v1beta/models": {
				status: 200,
				body: {
					models: [
						{
							name: "models/gemini-1.5-ultra",
							displayName: "Gemini 1.5 Ultra",
							description: "Ultra model.",
							inputTokenLimit: 2097152,
							outputTokenLimit: 8192,
							supportedGenerationMethods: ["generateContent", "countTokens"],
						},
					],
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		const ultra = cards[0];
		expect(ultra.capabilities).toContain("vision");
		expect(ultra.capabilities).toContain("function_calling");
		expect(ultra.capabilities).toContain("code");
		expect(ultra.capabilities).toContain("nlu");
	});

	/** Verify pagination follows nextPageToken across multiple pages. */
	it("should handle pagination", async () => {
		const page1 = {
			models: [
				{
					name: "models/gemini-2.5-pro",
					displayName: "Gemini 2.5 Pro",
					description: "Page 1 model.",
					inputTokenLimit: 1048576,
					outputTokenLimit: 65536,
					supportedGenerationMethods: ["generateContent"],
				},
			],
			nextPageToken: "page2token",
		};

		const page2 = {
			models: [
				{
					name: "models/gemini-2.0-flash",
					displayName: "Gemini 2.0 Flash",
					description: "Page 2 model.",
					inputTokenLimit: 1048576,
					outputTokenLimit: 8192,
					supportedGenerationMethods: ["generateContent"],
				},
			],
		};

		// Manual mock to distinguish page 1 vs page 2 by pageToken query param
		let callCount = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			callCount++;
			const body = url.includes("pageToken") ? page2 : page1;
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
		expect(cards[0].id).toBe("gemini-2.5-pro");
		expect(cards[1].id).toBe("gemini-2.0-flash");
	});

	/** API returning a non-OK status should throw a descriptive error. */
	it("should throw on API error", async () => {
		mockFetch({
			"https://generativelanguage.googleapis.com/v1beta/models": {
				status: 401,
				body: { error: { message: "API key not valid" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Google API error: 401");
	});

	/** Network timeout should throw a timed-out error. */
	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	/** Verify default ModelCard fields are set correctly by makeCard. */
	it("should set correct default fields on ModelCard", async () => {
		mockFetch({
			"https://generativelanguage.googleapis.com/v1beta/models": {
				status: 200,
				body: {
					models: [
						{
							name: "models/gemini-2.5-pro",
							displayName: "Gemini 2.5 Pro",
							description: "Test model.",
							inputTokenLimit: 1048576,
							outputTokenLimit: 65536,
							supportedGenerationMethods: ["generateContent"],
						},
					],
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		const card = cards[0];

		expect(card.aliases).toEqual([]);
		expect(card.discoveredAt).toBeGreaterThan(0);
		expect(card.source).toBe("api");
		expect(card.provider).toBe("google");
	});
});
