import { afterEach, describe, expect, it } from "vitest";
import { NvidiaDiscoverer } from "../../src/discovery/nvidia.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new NvidiaDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "nvapi-test-key-123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{ id: "nvidia/llama-3.1-nemotron-70b-instruct", object: "model", created: 1700000000, owned_by: "nvidia" },
		{ id: "meta/llama-3.1-405b-instruct", object: "model", created: 1700000001, owned_by: "nvidia" },
		{ id: "mistralai/mistral-large-2-instruct", object: "model", created: 1700000002, owned_by: "nvidia" },
		{ id: "google/gemma-2-27b-it", object: "model", created: 1700000003, owned_by: "nvidia" },
		{ id: "deepseek/deepseek-r1", object: "model", created: 1700000004, owned_by: "nvidia" },
		{ id: "nvidia/nemotron-4-340b-instruct", object: "model", created: 1700000005, owned_by: "nvidia" },
		{ id: "microsoft/phi-3-medium-128k-instruct", object: "model", created: 1700000006, owned_by: "nvidia" },
		{ id: "nvidia/neva-22b", object: "model", created: 1700000007, owned_by: "nvidia" },
		{ id: "snowflake/arctic-embed-l-v2.0", object: "model", created: 1700000008, owned_by: "nvidia" },
		{ id: "nvidia/llama-3.1-nemotron-nano-8b-v1", object: "model", created: 1700000009, owned_by: "nvidia" },
		// These should be filtered out:
		{ id: "nvidia/nemotron-4-340b-reward", object: "model", created: 1700000010, owned_by: "nvidia" },
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("NvidiaDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("nvidia");
		expect(discoverer.providerName).toBe("NVIDIA");
		expect(discoverer.baseUrl).toBe("https://integrate.api.nvidia.com");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover models and filter correctly", async () => {
		mockFetch({
			"https://integrate.api.nvidia.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Should include all except the reward model
		expect(cards).toHaveLength(10);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("nvidia/llama-3.1-nemotron-70b-instruct");
		expect(ids).toContain("meta/llama-3.1-405b-instruct");
		expect(ids).toContain("snowflake/arctic-embed-l-v2.0");
		expect(ids).not.toContain("nvidia/nemotron-4-340b-reward");
	});

	it("should extract origin provider from model ID prefix", async () => {
		mockFetch({
			"https://integrate.api.nvidia.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const nvidiaModel = cards.find((c) => c.id === "nvidia/llama-3.1-nemotron-70b-instruct");
		expect(nvidiaModel!.originProvider).toBe("nvidia");

		const metaModel = cards.find((c) => c.id === "meta/llama-3.1-405b-instruct");
		expect(metaModel!.originProvider).toBe("meta");

		const mistralModel = cards.find((c) => c.id === "mistralai/mistral-large-2-instruct");
		expect(mistralModel!.originProvider).toBe("mistral");

		const googleModel = cards.find((c) => c.id === "google/gemma-2-27b-it");
		expect(googleModel!.originProvider).toBe("google");

		const deepseekModel = cards.find((c) => c.id === "deepseek/deepseek-r1");
		expect(deepseekModel!.originProvider).toBe("deepseek");

		const msModel = cards.find((c) => c.id === "microsoft/phi-3-medium-128k-instruct");
		expect(msModel!.originProvider).toBe("microsoft");
	});

	it("should classify chat models with correct capabilities", async () => {
		mockFetch({
			"https://integrate.api.nvidia.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Instruct model — should have chat + function_calling
		const nemotron = cards.find((c) => c.id === "nvidia/llama-3.1-nemotron-70b-instruct");
		expect(nemotron!.mode).toBe("chat");
		expect(nemotron!.capabilities).toContain("chat");
		expect(nemotron!.capabilities).toContain("function_calling");

		// Nemotron model — should have function_calling
		const nemotron4 = cards.find((c) => c.id === "nvidia/nemotron-4-340b-instruct");
		expect(nemotron4!.mode).toBe("chat");
		expect(nemotron4!.capabilities).toContain("function_calling");
	});

	it("should classify vision models correctly", async () => {
		mockFetch({
			"https://integrate.api.nvidia.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// NeVA is a vision model
		const neva = cards.find((c) => c.id === "nvidia/neva-22b");
		expect(neva!.mode).toBe("chat");
		expect(neva!.capabilities).toContain("vision");
	});

	it("should classify embedding models correctly", async () => {
		mockFetch({
			"https://integrate.api.nvidia.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const embedding = cards.find((c) => c.id === "snowflake/arctic-embed-l-v2.0");
		expect(embedding!.mode).toBe("embedding");
		expect(embedding!.capabilities).toEqual(["embedding"]);
	});

	it("should throw on API error", async () => {
		mockFetch({
			"https://integrate.api.nvidia.com/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("NVIDIA API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct provider and source on all cards", async () => {
		mockFetch({
			"https://integrate.api.nvidia.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("nvidia");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
