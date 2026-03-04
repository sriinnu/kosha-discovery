import { afterEach, describe, expect, it } from "vitest";
import { MistralDiscoverer } from "../../src/discovery/mistral.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new MistralDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "test-mistral-api-key-123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{ id: "mistral-large-latest", object: "model", created: 1700000000, owned_by: "mistralai" },
		{ id: "mistral-small-latest", object: "model", created: 1700000001, owned_by: "mistralai" },
		{ id: "codestral-latest", object: "model", created: 1700000002, owned_by: "mistralai" },
		{ id: "mistral-embed", object: "model", created: 1700000003, owned_by: "mistralai" },
		{ id: "pixtral-large-latest", object: "model", created: 1700000004, owned_by: "mistralai" },
		{ id: "open-mistral-nemo", object: "model", created: 1700000005, owned_by: "mistralai" },
		{ id: "ministral-8b-latest", object: "model", created: 1700000006, owned_by: "mistralai" },
		// These should be filtered out:
		{ id: "ft:mistral-small:custom:abc123", object: "model", created: 1700000007, owned_by: "mistralai" },
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("MistralDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("mistral");
		expect(discoverer.providerName).toBe("Mistral AI");
		expect(discoverer.baseUrl).toBe("https://api.mistral.ai");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover models and filter correctly", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Should include all except the fine-tuned model
		expect(cards).toHaveLength(7);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("mistral-large-latest");
		expect(ids).toContain("mistral-small-latest");
		expect(ids).toContain("codestral-latest");
		expect(ids).toContain("mistral-embed");
		expect(ids).toContain("pixtral-large-latest");
		expect(ids).toContain("open-mistral-nemo");
		expect(ids).toContain("ministral-8b-latest");
		expect(ids).not.toContain("ft:mistral-small:custom:abc123");
	});

	it("should always set originProvider to mistral", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.originProvider).toBe("mistral");
		}
	});

	it("should classify chat models with correct capabilities", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Standard chat model — should have chat + function_calling
		const mistralSmall = cards.find((c) => c.id === "mistral-small-latest");
		expect(mistralSmall!.mode).toBe("chat");
		expect(mistralSmall!.capabilities).toContain("chat");
		expect(mistralSmall!.capabilities).toContain("function_calling");

		// Open model — should have chat + function_calling
		const nemo = cards.find((c) => c.id === "open-mistral-nemo");
		expect(nemo!.mode).toBe("chat");
		expect(nemo!.capabilities).toContain("chat");
		expect(nemo!.capabilities).toContain("function_calling");
	});

	it("should classify large models with nlu capability", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Large model — should have nlu in addition to chat + function_calling
		const mistralLarge = cards.find((c) => c.id === "mistral-large-latest");
		expect(mistralLarge!.mode).toBe("chat");
		expect(mistralLarge!.capabilities).toContain("chat");
		expect(mistralLarge!.capabilities).toContain("function_calling");
		expect(mistralLarge!.capabilities).toContain("nlu");

		// pixtral-large also carries nlu
		const pixtralLarge = cards.find((c) => c.id === "pixtral-large-latest");
		expect(pixtralLarge!.capabilities).toContain("nlu");
	});

	it("should classify vision models correctly", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Pixtral is Mistral's vision model
		const pixtral = cards.find((c) => c.id === "pixtral-large-latest");
		expect(pixtral!.mode).toBe("chat");
		expect(pixtral!.capabilities).toContain("vision");
	});

	it("should classify code models correctly", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Codestral is Mistral's code model
		const codestral = cards.find((c) => c.id === "codestral-latest");
		expect(codestral!.mode).toBe("chat");
		expect(codestral!.capabilities).toContain("code");
		expect(codestral!.capabilities).toContain("function_calling");
	});

	it("should classify embedding models correctly", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const embedding = cards.find((c) => c.id === "mistral-embed");
		expect(embedding!.mode).toBe("embedding");
		expect(embedding!.capabilities).toEqual(["embedding"]);
	});

	it("should throw on API error", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Mistral AI API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct provider and source on all cards", async () => {
		mockFetch({
			"https://api.mistral.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("mistral");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
