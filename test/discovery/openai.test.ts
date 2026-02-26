import { afterEach, describe, expect, it } from "vitest";
import { OpenAIDiscoverer } from "../../src/discovery/openai.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new OpenAIDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "sk-test-openai-key",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{ id: "gpt-4o", object: "model", created: 1715367049, owned_by: "system" },
		{ id: "gpt-4o-mini", object: "model", created: 1721172741, owned_by: "system" },
		{ id: "gpt-4-turbo", object: "model", created: 1712361441, owned_by: "system" },
		{ id: "gpt-3.5-turbo", object: "model", created: 1677610602, owned_by: "openai" },
		{ id: "o1-preview", object: "model", created: 1725648897, owned_by: "system" },
		{ id: "o3-mini", object: "model", created: 1738012800, owned_by: "system" },
		{ id: "text-embedding-3-large", object: "model", created: 1705953180, owned_by: "system" },
		{ id: "text-embedding-3-small", object: "model", created: 1705948997, owned_by: "system" },
		{ id: "dall-e-3", object: "model", created: 1698785189, owned_by: "system" },
		{ id: "whisper-1", object: "model", created: 1677532384, owned_by: "openai-internal" },
		{ id: "tts-1", object: "model", created: 1681940951, owned_by: "openai-internal" },
		// These should be filtered out:
		{ id: "ft:gpt-4o:myorg:custom:abc123", object: "model", created: 1700000000, owned_by: "user" },
		{ id: "babbage-002", object: "model", created: 1692634615, owned_by: "system" },
		{ id: "davinci-002", object: "model", created: 1692634301, owned_by: "system" },
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("OpenAIDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("openai");
		expect(discoverer.providerName).toBe("OpenAI");
		expect(discoverer.baseUrl).toBe("https://api.openai.com");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover models and filter correctly", async () => {
		mockFetch({
			"https://api.openai.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// Should include: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo,
		// o1-preview, o3-mini, text-embedding-3-large, text-embedding-3-small,
		// dall-e-3, whisper-1, tts-1
		// Should exclude: ft:gpt-4o:..., babbage-002, davinci-002
		expect(cards).toHaveLength(11);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("gpt-4o");
		expect(ids).toContain("text-embedding-3-large");
		expect(ids).toContain("dall-e-3");
		expect(ids).toContain("whisper-1");
		expect(ids).not.toContain("ft:gpt-4o:myorg:custom:abc123");
		expect(ids).not.toContain("babbage-002");
		expect(ids).not.toContain("davinci-002");
	});

	it("should classify chat models correctly", async () => {
		mockFetch({
			"https://api.openai.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// GPT-4o — full capabilities with vision
		const gpt4o = cards.find((c) => c.id === "gpt-4o");
		expect(gpt4o!.mode).toBe("chat");
		expect(gpt4o!.capabilities).toContain("vision");
		expect(gpt4o!.capabilities).toContain("function_calling");
		expect(gpt4o!.capabilities).toContain("code");

		// GPT-4 turbo — full capabilities with vision
		const gpt4turbo = cards.find((c) => c.id === "gpt-4-turbo");
		expect(gpt4turbo!.mode).toBe("chat");
		expect(gpt4turbo!.capabilities).toContain("vision");

		// o1-preview — reasoning model, no function_calling
		const o1 = cards.find((c) => c.id === "o1-preview");
		expect(o1!.mode).toBe("chat");
		expect(o1!.capabilities).toContain("code");
		expect(o1!.capabilities).toContain("nlu");
		expect(o1!.capabilities).not.toContain("function_calling");
	});

	it("should classify embedding models correctly", async () => {
		mockFetch({
			"https://api.openai.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const embedding = cards.find((c) => c.id === "text-embedding-3-large");
		expect(embedding!.mode).toBe("embedding");
		expect(embedding!.capabilities).toEqual(["embedding"]);
	});

	it("should classify image models correctly", async () => {
		mockFetch({
			"https://api.openai.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const dalle = cards.find((c) => c.id === "dall-e-3");
		expect(dalle!.mode).toBe("image");
		expect(dalle!.capabilities).toContain("image_generation");
	});

	it("should classify audio models correctly", async () => {
		mockFetch({
			"https://api.openai.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const whisper = cards.find((c) => c.id === "whisper-1");
		expect(whisper!.mode).toBe("audio");
		expect(whisper!.capabilities).toContain("speech_to_text");

		const tts = cards.find((c) => c.id === "tts-1");
		expect(tts!.mode).toBe("audio");
		expect(tts!.capabilities).toContain("text_to_speech");
	});

	it("should throw on API error", async () => {
		mockFetch({
			"https://api.openai.com/v1/models": {
				status: 401,
				body: { error: { message: "Incorrect API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("OpenAI API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct provider and source on all cards", async () => {
		mockFetch({
			"https://api.openai.com/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("openai");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
