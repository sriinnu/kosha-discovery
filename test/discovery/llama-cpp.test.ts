import { afterEach, describe, expect, it } from "vitest";
import { LlamaCppDiscoverer } from "../../src/discovery/llama-cpp.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchError, restoreFetch } from "./mock-server.js";

const discoverer = new LlamaCppDiscoverer();
const credential: CredentialResult = { source: "none" };

const mockResponse = {
	data: [
		{
			id: "/models/llama-3.3-8b-instruct-q4_k_m.gguf",
			object: "model",
			context_window: 131072,
			metadata: {
				tokenizer_family: "llama",
				quantization: "Q4_K_M",
				memory_footprint_bytes: 4_600_000_000,
				compute_target: "gpu",
				supports_structured_output: true,
				supports_streaming: true,
			},
		},
		{
			id: "bge-rerank-v2-m3",
			object: "model",
		},
		{
			id: "nomic-embed-text-v1.5",
			object: "model",
		},
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("LlamaCppDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("llama.cpp");
		expect(discoverer.providerName).toBe("llama.cpp (Local)");
		expect(discoverer.baseUrl).toBe("http://127.0.0.1:8080");
	});

	it("should discover models from the local OpenAI-compatible endpoint", async () => {
		mockFetch({
			"http://127.0.0.1:8080/v1/models": {
				status: 200,
				body: mockResponse,
			},
		});

		const cards = await discoverer.discover(credential);
		expect(cards).toHaveLength(3);
		expect(cards[0].provider).toBe("llama.cpp");
		expect(cards[0].source).toBe("local");
	});

	it("should normalize path-like IDs and attach runtime metadata", async () => {
		mockFetch({
			"http://127.0.0.1:8080/v1/models": {
				status: 200,
				body: mockResponse,
			},
		});

		const cards = await discoverer.discover(credential);
		const llama = cards.find((card) => card.id === "llama-3.3-8b-instruct-q4_k_m.gguf");

		expect(llama).toBeDefined();
		expect(llama!.localRuntime?.runtimeFamily).toBe("llama.cpp");
		expect(llama!.localRuntime?.quantization).toBe("Q4_K_M");
		expect(llama!.localRuntime?.supportsStructuredOutput).toBe(true);
		expect(llama!.contextWindow).toBe(131072);
	});

	it("should classify rerank and embedding models", async () => {
		mockFetch({
			"http://127.0.0.1:8080/v1/models": {
				status: 200,
				body: mockResponse,
			},
		});

		const cards = await discoverer.discover(credential);
		const rerank = cards.find((card) => card.id === "bge-rerank-v2-m3");
		const embedding = cards.find((card) => card.id === "nomic-embed-text-v1.5");

		expect(rerank?.mode).toBe("rerank");
		expect(rerank?.capabilities).toEqual(["rerank"]);
		expect(embedding?.mode).toBe("embedding");
		expect(embedding?.capabilities).toEqual(["embedding"]);
	});

	it("should return an empty array when llama.cpp is unavailable", async () => {
		mockFetchError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8080"));
		await expect(discoverer.discover(credential)).resolves.toEqual([]);
	});
});
