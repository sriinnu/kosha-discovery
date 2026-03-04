import { afterEach, describe, expect, it } from "vitest";
import { TogetherDiscoverer } from "../../src/discovery/together.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new TogetherDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "together-test-key-123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{ id: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", object: "model", created: 1700000000, owned_by: "together", type: "chat" },
		{ id: "mistralai/Mixtral-8x22B-Instruct-v0.1", object: "model", created: 1700000001, owned_by: "together", type: "chat" },
		{ id: "Qwen/Qwen2.5-72B-Instruct-Turbo", object: "model", created: 1700000002, owned_by: "together", type: "chat" },
		{ id: "google/gemma-2-27b-it", object: "model", created: 1700000003, owned_by: "together", type: "chat" },
		{ id: "deepseek-ai/DeepSeek-R1", object: "model", created: 1700000004, owned_by: "together", type: "chat" },
		{ id: "togethercomputer/StripedHyena-Nous-7B", object: "model", created: 1700000005, owned_by: "together", type: "chat" },
		{ id: "BAAI/bge-large-en-v1.5", object: "model", created: 1700000006, owned_by: "together", type: "embedding" },
		{ id: "meta-llama/Llama-Vision-Free", object: "model", created: 1700000007, owned_by: "together", type: "chat" },
		// These should be filtered out:
		{ id: "nvidia/nemotron-4-340b-reward", object: "model", created: 1700000008, owned_by: "together", type: "chat" },
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("TogetherDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("together");
		expect(discoverer.providerName).toBe("Together AI");
		expect(discoverer.baseUrl).toBe("https://api.together.xyz");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover models and filter correctly", async () => {
		mockFetch({
			"https://api.together.xyz/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Should include all except the reward model
		expect(cards).toHaveLength(8);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo");
		expect(ids).toContain("mistralai/Mixtral-8x22B-Instruct-v0.1");
		expect(ids).toContain("BAAI/bge-large-en-v1.5");
		expect(ids).not.toContain("nvidia/nemotron-4-340b-reward");
	});

	it("should extract origin provider from model ID prefix", async () => {
		mockFetch({
			"https://api.together.xyz/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const metaModel = cards.find((c) => c.id === "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo");
		expect(metaModel!.originProvider).toBe("meta");

		const mistralModel = cards.find((c) => c.id === "mistralai/Mixtral-8x22B-Instruct-v0.1");
		expect(mistralModel!.originProvider).toBe("mistral");

		const qwenModel = cards.find((c) => c.id === "Qwen/Qwen2.5-72B-Instruct-Turbo");
		expect(qwenModel!.originProvider).toBe("qwen");

		const googleModel = cards.find((c) => c.id === "google/gemma-2-27b-it");
		expect(googleModel!.originProvider).toBe("google");

		const deepseekModel = cards.find((c) => c.id === "deepseek-ai/DeepSeek-R1");
		expect(deepseekModel!.originProvider).toBe("deepseek");

		const togetherModel = cards.find((c) => c.id === "togethercomputer/StripedHyena-Nous-7B");
		expect(togetherModel!.originProvider).toBe("together");
	});

	it("should classify chat models with correct capabilities", async () => {
		mockFetch({
			"https://api.together.xyz/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Instruct model — should have chat + function_calling
		const llama = cards.find((c) => c.id === "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo");
		expect(llama!.mode).toBe("chat");
		expect(llama!.capabilities).toContain("chat");
		expect(llama!.capabilities).toContain("function_calling");

		const mixtral = cards.find((c) => c.id === "mistralai/Mixtral-8x22B-Instruct-v0.1");
		expect(mixtral!.mode).toBe("chat");
		expect(mixtral!.capabilities).toContain("function_calling");
	});

	it("should classify vision models correctly", async () => {
		mockFetch({
			"https://api.together.xyz/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const vision = cards.find((c) => c.id === "meta-llama/Llama-Vision-Free");
		expect(vision!.mode).toBe("chat");
		expect(vision!.capabilities).toContain("vision");
	});

	it("should classify embedding models correctly", async () => {
		mockFetch({
			"https://api.together.xyz/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const embedding = cards.find((c) => c.id === "BAAI/bge-large-en-v1.5");
		expect(embedding!.mode).toBe("embedding");
		expect(embedding!.capabilities).toEqual(["embedding"]);
	});

	it("should throw on API error", async () => {
		mockFetch({
			"https://api.together.xyz/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Together AI API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct provider and source on all cards", async () => {
		mockFetch({
			"https://api.together.xyz/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("together");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
