import { afterEach, describe, expect, it } from "vitest";
import { DeepInfraDiscoverer } from "../../src/discovery/deepinfra.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new DeepInfraDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "di-test-key-abc123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{
			id: "meta-llama/Meta-Llama-3.1-405B-Instruct",
			object: "model",
			created: 1700000000,
			owned_by: "meta-llama",
		},
		{
			id: "mistralai/Mixtral-8x22B-Instruct-v0.1",
			object: "model",
			created: 1700000001,
			owned_by: "mistralai",
		},
		{
			id: "Qwen/Qwen2.5-72B-Instruct",
			object: "model",
			created: 1700000002,
			owned_by: "Qwen",
		},
		{
			id: "deepseek-ai/DeepSeek-R1",
			object: "model",
			created: 1700000003,
			owned_by: "deepseek-ai",
		},
		{
			id: "BAAI/bge-large-en-v1.5",
			object: "model",
			created: 1700000004,
			owned_by: "BAAI",
			type: "embedding",
		},
		{
			id: "meta-llama/Llama-3.2-90B-Vision-Instruct",
			object: "model",
			created: 1700000005,
			owned_by: "meta-llama",
		},
		{
			id: "bigcode/starcoder2-15b",
			object: "model",
			created: 1700000006,
			owned_by: "bigcode",
		},
		// Should be filtered out — reward model
		{
			id: "meta-llama/Meta-Llama-3.1-70B-Reward",
			object: "model",
			created: 1700000007,
			owned_by: "meta-llama",
		},
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("DeepInfraDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("deepinfra");
		expect(discoverer.providerName).toBe("DeepInfra");
		expect(discoverer.baseUrl).toBe("https://api.deepinfra.com");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover models and filter out reward models", async () => {
		mockFetch({
			"https://api.deepinfra.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// 8 total in mock, 1 reward model filtered out — expect 7
		expect(cards).toHaveLength(7);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("meta-llama/Meta-Llama-3.1-405B-Instruct");
		expect(ids).toContain("mistralai/Mixtral-8x22B-Instruct-v0.1");
		expect(ids).toContain("Qwen/Qwen2.5-72B-Instruct");
		expect(ids).toContain("deepseek-ai/DeepSeek-R1");
		expect(ids).toContain("BAAI/bge-large-en-v1.5");
		expect(ids).toContain("meta-llama/Llama-3.2-90B-Vision-Instruct");
		expect(ids).toContain("bigcode/starcoder2-15b");
		// Reward model must not appear
		expect(ids).not.toContain("meta-llama/Meta-Llama-3.1-70B-Reward");
	});

	it("should extract origin provider from model ID prefix with aliases", async () => {
		mockFetch({
			"https://api.deepinfra.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// meta-llama -> meta
		const llamaModel = cards.find((c) => c.id === "meta-llama/Meta-Llama-3.1-405B-Instruct");
		expect(llamaModel!.originProvider).toBe("meta");

		// mistralai -> mistral
		const mixtralModel = cards.find((c) => c.id === "mistralai/Mixtral-8x22B-Instruct-v0.1");
		expect(mixtralModel!.originProvider).toBe("mistral");

		// deepseek-ai -> deepseek
		const deepseekModel = cards.find((c) => c.id === "deepseek-ai/DeepSeek-R1");
		expect(deepseekModel!.originProvider).toBe("deepseek");

		// bigcode -> mistral (alias)
		const starcoderModel = cards.find((c) => c.id === "bigcode/starcoder2-15b");
		expect(starcoderModel!.originProvider).toBe("mistral");

		// Qwen — no alias, lowercase prefix used as-is
		const qwenModel = cards.find((c) => c.id === "Qwen/Qwen2.5-72B-Instruct");
		expect(qwenModel!.originProvider).toBe("qwen");
	});

	it("should classify chat models with correct capabilities", async () => {
		mockFetch({
			"https://api.deepinfra.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Instruct model — should have chat + function_calling
		const llama405b = cards.find((c) => c.id === "meta-llama/Meta-Llama-3.1-405B-Instruct");
		expect(llama405b!.mode).toBe("chat");
		expect(llama405b!.capabilities).toContain("chat");
		expect(llama405b!.capabilities).toContain("function_calling");

		// Instruct model (Mixtral) — should also have function_calling
		const mixtral = cards.find((c) => c.id === "mistralai/Mixtral-8x22B-Instruct-v0.1");
		expect(mixtral!.mode).toBe("chat");
		expect(mixtral!.capabilities).toContain("function_calling");

		// DeepSeek-R1 — no "instruct" or "chat" in ID, should not get function_calling
		const deepseek = cards.find((c) => c.id === "deepseek-ai/DeepSeek-R1");
		expect(deepseek!.mode).toBe("chat");
		expect(deepseek!.capabilities).toContain("chat");
		expect(deepseek!.capabilities).not.toContain("function_calling");
	});

	it("should classify vision models correctly", async () => {
		mockFetch({
			"https://api.deepinfra.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const visionModel = cards.find((c) => c.id === "meta-llama/Llama-3.2-90B-Vision-Instruct");
		expect(visionModel!.mode).toBe("chat");
		expect(visionModel!.capabilities).toContain("vision");
		expect(visionModel!.capabilities).toContain("function_calling");
	});

	it("should classify embedding models correctly", async () => {
		mockFetch({
			"https://api.deepinfra.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// BAAI/bge-large-en-v1.5 has type: "embedding"
		const embedding = cards.find((c) => c.id === "BAAI/bge-large-en-v1.5");
		expect(embedding!.mode).toBe("embedding");
		expect(embedding!.capabilities).toEqual(["embedding"]);
	});

	it("should classify code models correctly", async () => {
		mockFetch({
			"https://api.deepinfra.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// bigcode/starcoder2-15b — "starcoder" triggers looksLikeCode
		const starcoder = cards.find((c) => c.id === "bigcode/starcoder2-15b");
		expect(starcoder!.mode).toBe("chat");
		expect(starcoder!.capabilities).toContain("code");
	});

	it("should throw on API error (401)", async () => {
		mockFetch({
			"https://api.deepinfra.com/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("DeepInfra API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct card fields on all discovered models", async () => {
		mockFetch({
			"https://api.deepinfra.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("deepinfra");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
