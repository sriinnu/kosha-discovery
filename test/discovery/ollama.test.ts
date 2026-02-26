import { afterEach, describe, expect, it } from "vitest";
import { OllamaDiscoverer } from "../../src/discovery/ollama.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchError, restoreFetch } from "./mock-server.js";

const discoverer = new OllamaDiscoverer();

// Ollama doesn't need credentials
const credential: CredentialResult = {
	source: "none",
};

const mockTagsResponse = {
	models: [
		{
			name: "llama3.1:8b",
			model: "llama3.1:8b",
			modified_at: "2024-07-23T00:00:00Z",
			size: 4_661_224_676,
			digest: "abc123",
			details: {
				families: ["llama"],
				parameter_size: "8B",
				quantization_level: "Q4_0",
			},
		},
		{
			name: "qwen3:8b",
			model: "qwen3:8b",
			modified_at: "2025-05-01T00:00:00Z",
			size: 5_000_000_000,
			digest: "def456",
			details: {
				families: ["qwen2"],
				parameter_size: "8B",
				quantization_level: "Q4_K_M",
			},
		},
		{
			name: "nomic-embed-text:latest",
			model: "nomic-embed-text:latest",
			modified_at: "2024-03-01T00:00:00Z",
			size: 274_302_450,
			digest: "ghi789",
			details: {
				families: ["nomic-bert"],
				parameter_size: "137M",
				quantization_level: "F16",
			},
		},
		{
			name: "codellama:7b",
			model: "codellama:7b",
			modified_at: "2024-01-15T00:00:00Z",
			size: 3_825_819_519,
			digest: "jkl012",
			details: {
				families: ["llama"],
				parameter_size: "7B",
				quantization_level: "Q4_0",
			},
		},
		{
			name: "llava:13b",
			model: "llava:13b",
			modified_at: "2024-02-01T00:00:00Z",
			size: 8_000_000_000,
			digest: "mno345",
			details: {
				families: ["llama", "clip"],
				parameter_size: "13B",
				quantization_level: "Q4_0",
			},
		},
	],
};

const mockPsResponse = {
	models: [
		{
			name: "llama3.1:8b",
			model: "llama3.1:8b",
			size: 4_661_224_676,
			digest: "abc123",
			expires_at: "2025-01-01T00:10:00Z",
		},
	],
};

afterEach(() => {
	restoreFetch();
});

describe("OllamaDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("ollama");
		expect(discoverer.providerName).toBe("Ollama (Local)");
		expect(discoverer.baseUrl).toBe("http://localhost:11434");
	});

	it("should accept custom base URL", () => {
		const custom = new OllamaDiscoverer("http://192.168.1.100:11434");
		expect(custom.baseUrl).toBe("http://192.168.1.100:11434");
	});

	it("should discover local models", async () => {
		mockFetch({
			"http://localhost:11434/api/ps": {
				status: 200,
				body: mockPsResponse,
			},
			"http://localhost:11434/api/tags": {
				status: 200,
				body: mockTagsResponse,
			},
		});

		const cards = await discoverer.discover(credential);

		expect(cards).toHaveLength(5);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("llama3.1:8b");
		expect(ids).toContain("qwen3:8b");
		expect(ids).toContain("nomic-embed-text:latest");
		expect(ids).toContain("codellama:7b");
		expect(ids).toContain("llava:13b");
	});

	it("should set source to local for all models", async () => {
		mockFetch({
			"http://localhost:11434/api/ps": {
				status: 200,
				body: mockPsResponse,
			},
			"http://localhost:11434/api/tags": {
				status: 200,
				body: mockTagsResponse,
			},
		});

		const cards = await discoverer.discover(credential);

		for (const card of cards) {
			expect(card.source).toBe("local");
			expect(card.provider).toBe("ollama");
		}
	});

	it("should detect embedding models", async () => {
		mockFetch({
			"http://localhost:11434/api/ps": {
				status: 200,
				body: { models: [] },
			},
			"http://localhost:11434/api/tags": {
				status: 200,
				body: mockTagsResponse,
			},
		});

		const cards = await discoverer.discover(credential);

		const embedModel = cards.find((c) => c.id === "nomic-embed-text:latest");
		expect(embedModel).toBeDefined();
		expect(embedModel!.mode).toBe("embedding");
		expect(embedModel!.capabilities).toEqual(["embedding"]);
	});

	it("should detect code models", async () => {
		mockFetch({
			"http://localhost:11434/api/ps": {
				status: 200,
				body: { models: [] },
			},
			"http://localhost:11434/api/tags": {
				status: 200,
				body: mockTagsResponse,
			},
		});

		const cards = await discoverer.discover(credential);

		const codeModel = cards.find((c) => c.id === "codellama:7b");
		expect(codeModel).toBeDefined();
		expect(codeModel!.mode).toBe("chat");
		expect(codeModel!.capabilities).toContain("code");
	});

	it("should detect vision models via clip family", async () => {
		mockFetch({
			"http://localhost:11434/api/ps": {
				status: 200,
				body: { models: [] },
			},
			"http://localhost:11434/api/tags": {
				status: 200,
				body: mockTagsResponse,
			},
		});

		const cards = await discoverer.discover(credential);

		const visionModel = cards.find((c) => c.id === "llava:13b");
		expect(visionModel).toBeDefined();
		expect(visionModel!.capabilities).toContain("vision");
	});

	it("should return empty array when Ollama is not running (ECONNREFUSED)", async () => {
		const connError = new Error("fetch failed: ECONNREFUSED 127.0.0.1:11434");
		mockFetchError(connError);

		const cards = await discoverer.discover(credential);
		expect(cards).toEqual([]);
	});

	it("should return empty array on network timeout", async () => {
		const timeoutError = new Error("Ollama (Local) API request timed out after 50ms");
		mockFetchError(timeoutError);

		const cards = await discoverer.discover(credential);
		expect(cards).toEqual([]);
	});

	it("should handle empty models list", async () => {
		mockFetch({
			"http://localhost:11434/api/ps": {
				status: 200,
				body: { models: [] },
			},
			"http://localhost:11434/api/tags": {
				status: 200,
				body: { models: [] },
			},
		});

		const cards = await discoverer.discover(credential);
		expect(cards).toEqual([]);
	});

	it("should set contextWindow and maxOutputTokens to 0 (unknown)", async () => {
		mockFetch({
			"http://localhost:11434/api/ps": {
				status: 200,
				body: { models: [] },
			},
			"http://localhost:11434/api/tags": {
				status: 200,
				body: mockTagsResponse,
			},
		});

		const cards = await discoverer.discover(credential);

		for (const card of cards) {
			expect(card.contextWindow).toBe(0);
			expect(card.maxOutputTokens).toBe(0);
		}
	});

	it("should handle missing /api/ps gracefully", async () => {
		// Simulate ps endpoint failing but tags working
		let callCount = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			callCount++;
			if (url.includes("/api/ps")) {
				throw new Error("Not found");
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => mockTagsResponse,
				text: async () => JSON.stringify(mockTagsResponse),
			} as Response;
		}) as typeof globalThis.fetch;

		const cards = await discoverer.discover(credential);
		globalThis.fetch = originalFetch;

		// Should still return models even if /api/ps fails
		expect(cards).toHaveLength(5);
	});
});
