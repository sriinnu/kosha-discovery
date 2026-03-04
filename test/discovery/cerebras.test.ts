import { afterEach, describe, expect, it } from "vitest";
import { CerebrasDiscoverer } from "../../src/discovery/cerebras.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new CerebrasDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "csk-test-key-123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{ id: "llama3.1-8b", object: "model", created: 1700000000, owned_by: "cerebras" },
		{ id: "llama3.1-70b", object: "model", created: 1700000001, owned_by: "cerebras" },
		{ id: "llama-3.3-70b", object: "model", created: 1700000002, owned_by: "cerebras" },
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("CerebrasDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("cerebras");
		expect(discoverer.providerName).toBe("Cerebras");
		expect(discoverer.baseUrl).toBe("https://api.cerebras.ai");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover all models (no filtering on curated catalog)", async () => {
		mockFetch({
			"https://api.cerebras.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		expect(cards).toHaveLength(3);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("llama3.1-8b");
		expect(ids).toContain("llama3.1-70b");
		expect(ids).toContain("llama-3.3-70b");
	});

	it("should resolve origin provider from keyword rules (all llama models → meta)", async () => {
		mockFetch({
			"https://api.cerebras.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const card8b = cards.find((c) => c.id === "llama3.1-8b");
		expect(card8b!.originProvider).toBe("meta");

		const card70b = cards.find((c) => c.id === "llama3.1-70b");
		expect(card70b!.originProvider).toBe("meta");

		const card33 = cards.find((c) => c.id === "llama-3.3-70b");
		expect(card33!.originProvider).toBe("meta");
	});

	it("should infer deepseek origin from keyword-based rules", async () => {
		mockFetch({
			"https://api.cerebras.ai/v1/models": {
				status: 200,
				body: {
					data: [
						{ id: "deepseek-r1-distill-llama-70b", object: "model", created: 1700000010, owned_by: "cerebras" },
					],
					object: "list",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);

		// "deepseek" keyword comes before "llama" in the rules, so deepseek wins
		expect(cards[0]!.originProvider).toBe("deepseek");
	});

	it("should infer mistral origin from keyword-based rules", async () => {
		mockFetch({
			"https://api.cerebras.ai/v1/models": {
				status: 200,
				body: {
					data: [
						{ id: "mistral-7b-instruct", object: "model", created: 1700000020, owned_by: "cerebras" },
					],
					object: "list",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards[0]!.originProvider).toBe("mistral");
	});

	it("should fall back to cerebras origin for unrecognised model IDs", async () => {
		mockFetch({
			"https://api.cerebras.ai/v1/models": {
				status: 200,
				body: {
					data: [
						{ id: "cerebras-gpt-111b", object: "model", created: 1700000030, owned_by: "cerebras" },
					],
					object: "list",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards[0]!.originProvider).toBe("cerebras");
	});

	it("should classify all models as chat mode with function_calling capability", async () => {
		mockFetch({
			"https://api.cerebras.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.mode).toBe("chat");
			expect(card.capabilities).toContain("chat");
			expect(card.capabilities).toContain("function_calling");
		}
	});

	it("should throw on API error (401 Unauthorized)", async () => {
		mockFetch({
			"https://api.cerebras.ai/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Cerebras API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct card fields (provider, source, aliases, discoveredAt) on all results", async () => {
		mockFetch({
			"https://api.cerebras.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("cerebras");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
