import { afterEach, describe, expect, it } from "vitest";
import { GroqDiscoverer } from "../../src/discovery/groq.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new GroqDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "gsk_test-key-123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{ id: "llama-3.3-70b-versatile", object: "model", created: 1700000000, owned_by: "groq", active: true, context_window: 131072 },
		{ id: "mixtral-8x7b-32768", object: "model", created: 1700000001, owned_by: "groq", active: true, context_window: 32768 },
		{ id: "gemma2-9b-it", object: "model", created: 1700000002, owned_by: "groq", active: true, context_window: 8192 },
		{ id: "deepseek-r1-distill-llama-70b", object: "model", created: 1700000003, owned_by: "groq", active: true, context_window: 131072 },
		{ id: "llama-guard-3-8b", object: "model", created: 1700000004, owned_by: "groq", active: true, context_window: 8192 },
		{ id: "whisper-large-v3-turbo", object: "model", created: 1700000005, owned_by: "groq", active: true, context_window: 0 },
		{ id: "llama-3.2-90b-vision-preview", object: "model", created: 1700000006, owned_by: "groq", active: true, context_window: 131072 },
		{ id: "qwen-2.5-coder-32b", object: "model", created: 1700000007, owned_by: "groq", active: true, context_window: 32768 },
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("GroqDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("groq");
		expect(discoverer.providerName).toBe("Groq");
		expect(discoverer.baseUrl).toBe("https://api.groq.com/openai");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover all models in the catalog", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Groq keeps all models — no filtering
		expect(cards).toHaveLength(8);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("llama-3.3-70b-versatile");
		expect(ids).toContain("mixtral-8x7b-32768");
		expect(ids).toContain("gemma2-9b-it");
		expect(ids).toContain("deepseek-r1-distill-llama-70b");
		expect(ids).toContain("llama-guard-3-8b");
		expect(ids).toContain("whisper-large-v3-turbo");
		expect(ids).toContain("llama-3.2-90b-vision-preview");
		expect(ids).toContain("qwen-2.5-coder-32b");
	});

	it("should infer origin provider from model name heuristics", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const llamaModel = cards.find((c) => c.id === "llama-3.3-70b-versatile");
		expect(llamaModel!.originProvider).toBe("meta");

		const mixtralModel = cards.find((c) => c.id === "mixtral-8x7b-32768");
		expect(mixtralModel!.originProvider).toBe("mistral");

		const gemmaModel = cards.find((c) => c.id === "gemma2-9b-it");
		expect(gemmaModel!.originProvider).toBe("google");

		const deepseekModel = cards.find((c) => c.id === "deepseek-r1-distill-llama-70b");
		expect(deepseekModel!.originProvider).toBe("deepseek");

		const whisperModel = cards.find((c) => c.id === "whisper-large-v3-turbo");
		expect(whisperModel!.originProvider).toBe("openai");

		const qwenModel = cards.find((c) => c.id === "qwen-2.5-coder-32b");
		expect(qwenModel!.originProvider).toBe("qwen");
	});

	it("should classify chat models with correct capabilities", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Standard chat model — should have chat + function_calling
		const llama = cards.find((c) => c.id === "llama-3.3-70b-versatile");
		expect(llama!.mode).toBe("chat");
		expect(llama!.capabilities).toContain("chat");
		expect(llama!.capabilities).toContain("function_calling");

		const mixtral = cards.find((c) => c.id === "mixtral-8x7b-32768");
		expect(mixtral!.mode).toBe("chat");
		expect(mixtral!.capabilities).toContain("chat");
		expect(mixtral!.capabilities).toContain("function_calling");
	});

	it("should classify guard models with moderation capability", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const guard = cards.find((c) => c.id === "llama-guard-3-8b");
		expect(guard!.mode).toBe("chat");
		expect(guard!.capabilities).toContain("chat");
		expect(guard!.capabilities).toContain("moderation");
		// Guard models should not get function_calling
		expect(guard!.capabilities).not.toContain("function_calling");
	});

	it("should classify whisper models as audio/speech-to-text", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const whisper = cards.find((c) => c.id === "whisper-large-v3-turbo");
		expect(whisper!.mode).toBe("audio");
		expect(whisper!.capabilities).toEqual(["speech_to_text"]);
	});

	it("should classify vision models with vision capability", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const vision = cards.find((c) => c.id === "llama-3.2-90b-vision-preview");
		expect(vision!.mode).toBe("chat");
		expect(vision!.capabilities).toContain("chat");
		expect(vision!.capabilities).toContain("vision");
		expect(vision!.capabilities).toContain("function_calling");
	});

	it("should classify code models with code capability", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const coder = cards.find((c) => c.id === "qwen-2.5-coder-32b");
		expect(coder!.mode).toBe("chat");
		expect(coder!.capabilities).toContain("chat");
		expect(coder!.capabilities).toContain("code");
		expect(coder!.capabilities).toContain("function_calling");
	});

	it("should pass through context_window from API response", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const llama = cards.find((c) => c.id === "llama-3.3-70b-versatile");
		expect(llama!.contextWindow).toBe(131072);

		const mixtral = cards.find((c) => c.id === "mixtral-8x7b-32768");
		expect(mixtral!.contextWindow).toBe(32768);
	});

	it("should throw on API error", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Groq API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct provider and source on all cards", async () => {
		mockFetch({
			"https://api.groq.com/openai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("groq");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
