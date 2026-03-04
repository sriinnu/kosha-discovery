import { afterEach, describe, expect, it } from "vitest";
import { FireworksDiscoverer } from "../../src/discovery/fireworks.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new FireworksDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "fw-test-key-123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{
			id: "accounts/fireworks/models/llama-v3p1-405b-instruct",
			object: "model",
			created: 1700000000,
			owned_by: "fireworks",
		},
		{
			id: "accounts/fireworks/models/mixtral-8x22b-instruct",
			object: "model",
			created: 1700000001,
			owned_by: "fireworks",
		},
		{
			id: "accounts/fireworks/models/qwen2p5-72b-instruct",
			object: "model",
			created: 1700000002,
			owned_by: "fireworks",
		},
		{
			id: "accounts/fireworks/models/deepseek-r1",
			object: "model",
			created: 1700000003,
			owned_by: "fireworks",
		},
		{
			id: "accounts/fireworks/models/phi-3-vision-128k-instruct",
			object: "model",
			created: 1700000004,
			owned_by: "fireworks",
		},
		{
			id: "accounts/fireworks/models/nomic-embed-text-v1.5",
			object: "model",
			created: 1700000005,
			owned_by: "fireworks",
		},
		{
			id: "accounts/fireworks/models/starcoder-16b",
			object: "model",
			created: 1700000006,
			owned_by: "fireworks",
		},
		// These should be filtered out:
		{
			id: "accounts/fireworks/models/llama-v3p1-70b-reward",
			object: "model",
			created: 1700000007,
			owned_by: "fireworks",
		},
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("FireworksDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("fireworks");
		expect(discoverer.providerName).toBe("Fireworks AI");
		expect(discoverer.baseUrl).toBe("https://api.fireworks.ai/inference");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover models and filter correctly", async () => {
		mockFetch({
			"https://api.fireworks.ai/inference/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Should include all except the reward model
		expect(cards).toHaveLength(7);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("accounts/fireworks/models/llama-v3p1-405b-instruct");
		expect(ids).toContain("accounts/fireworks/models/mixtral-8x22b-instruct");
		expect(ids).toContain("accounts/fireworks/models/nomic-embed-text-v1.5");
		expect(ids).not.toContain("accounts/fireworks/models/llama-v3p1-70b-reward");
	});

	it("should extract origin provider from model name keywords", async () => {
		mockFetch({
			"https://api.fireworks.ai/inference/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const llamaModel = cards.find((c) => c.id === "accounts/fireworks/models/llama-v3p1-405b-instruct");
		expect(llamaModel!.originProvider).toBe("meta");

		const mixtralModel = cards.find((c) => c.id === "accounts/fireworks/models/mixtral-8x22b-instruct");
		expect(mixtralModel!.originProvider).toBe("mistral");

		const qwenModel = cards.find((c) => c.id === "accounts/fireworks/models/qwen2p5-72b-instruct");
		expect(qwenModel!.originProvider).toBe("qwen");

		const deepseekModel = cards.find((c) => c.id === "accounts/fireworks/models/deepseek-r1");
		expect(deepseekModel!.originProvider).toBe("deepseek");

		const phiModel = cards.find((c) => c.id === "accounts/fireworks/models/phi-3-vision-128k-instruct");
		expect(phiModel!.originProvider).toBe("microsoft");

		const starcoderModel = cards.find((c) => c.id === "accounts/fireworks/models/starcoder-16b");
		expect(starcoderModel!.originProvider).toBe("mistral");
	});

	it("should classify instruct models with correct capabilities", async () => {
		mockFetch({
			"https://api.fireworks.ai/inference/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Instruct model — should have chat + function_calling
		const llama = cards.find((c) => c.id === "accounts/fireworks/models/llama-v3p1-405b-instruct");
		expect(llama!.mode).toBe("chat");
		expect(llama!.capabilities).toContain("chat");
		expect(llama!.capabilities).toContain("function_calling");

		const mixtral = cards.find((c) => c.id === "accounts/fireworks/models/mixtral-8x22b-instruct");
		expect(mixtral!.mode).toBe("chat");
		expect(mixtral!.capabilities).toContain("function_calling");
	});

	it("should classify vision models correctly", async () => {
		mockFetch({
			"https://api.fireworks.ai/inference/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const phi = cards.find((c) => c.id === "accounts/fireworks/models/phi-3-vision-128k-instruct");
		expect(phi!.mode).toBe("chat");
		expect(phi!.capabilities).toContain("vision");
	});

	it("should classify embedding models correctly", async () => {
		mockFetch({
			"https://api.fireworks.ai/inference/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const embedding = cards.find((c) => c.id === "accounts/fireworks/models/nomic-embed-text-v1.5");
		expect(embedding!.mode).toBe("embedding");
		expect(embedding!.capabilities).toEqual(["embedding"]);
	});

	it("should classify code models correctly", async () => {
		mockFetch({
			"https://api.fireworks.ai/inference/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const starcoder = cards.find((c) => c.id === "accounts/fireworks/models/starcoder-16b");
		expect(starcoder!.mode).toBe("chat");
		expect(starcoder!.capabilities).toContain("code");
	});

	it("should throw on API error", async () => {
		mockFetch({
			"https://api.fireworks.ai/inference/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Fireworks AI API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct provider and source on all cards", async () => {
		mockFetch({
			"https://api.fireworks.ai/inference/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("fireworks");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
