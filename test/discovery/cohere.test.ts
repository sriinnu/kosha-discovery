import { afterEach, describe, expect, it } from "vitest";
import { CohereDiscoverer } from "../../src/discovery/cohere.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new CohereDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "co-test-key-abc123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{ id: "command-r-plus", object: "model", created: 1700000000, owned_by: "cohere" },
		{ id: "command-r", object: "model", created: 1700000001, owned_by: "cohere" },
		{ id: "command-light", object: "model", created: 1700000002, owned_by: "cohere" },
		{ id: "embed-english-v3.0", object: "model", created: 1700000003, owned_by: "cohere" },
		{ id: "embed-multilingual-v3.0", object: "model", created: 1700000004, owned_by: "cohere" },
		{ id: "rerank-english-v3.0", object: "model", created: 1700000005, owned_by: "cohere" },
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("CohereDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("cohere");
		expect(discoverer.providerName).toBe("Cohere");
		expect(discoverer.baseUrl).toBe("https://api.cohere.com/compatibility");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover all models in the catalog", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		expect(cards).toHaveLength(6);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("command-r-plus");
		expect(ids).toContain("command-r");
		expect(ids).toContain("command-light");
		expect(ids).toContain("embed-english-v3.0");
		expect(ids).toContain("embed-multilingual-v3.0");
		expect(ids).toContain("rerank-english-v3.0");
	});

	it("should always set originProvider to cohere", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.originProvider).toBe("cohere");
		}
	});

	it("should classify chat models with function_calling capability", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const commandLight = cards.find((c) => c.id === "command-light");
		expect(commandLight!.mode).toBe("chat");
		expect(commandLight!.capabilities).toContain("chat");
		expect(commandLight!.capabilities).toContain("function_calling");
	});

	it("should add nlu capability to command-r-plus", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const commandRPlus = cards.find((c) => c.id === "command-r-plus");
		expect(commandRPlus!.mode).toBe("chat");
		expect(commandRPlus!.capabilities).toContain("chat");
		expect(commandRPlus!.capabilities).toContain("function_calling");
		expect(commandRPlus!.capabilities).toContain("nlu");
	});

	it("should add nlu capability to command-r", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const commandR = cards.find((c) => c.id === "command-r");
		expect(commandR!.mode).toBe("chat");
		expect(commandR!.capabilities).toContain("chat");
		expect(commandR!.capabilities).toContain("function_calling");
		expect(commandR!.capabilities).toContain("nlu");
	});

	it("should not add nlu capability to command-light", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const commandLight = cards.find((c) => c.id === "command-light");
		expect(commandLight!.capabilities).not.toContain("nlu");
	});

	it("should classify embed models with embedding mode and caps", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const embedEnglish = cards.find((c) => c.id === "embed-english-v3.0");
		expect(embedEnglish!.mode).toBe("embedding");
		expect(embedEnglish!.capabilities).toEqual(["embedding"]);

		const embedMultilingual = cards.find((c) => c.id === "embed-multilingual-v3.0");
		expect(embedMultilingual!.mode).toBe("embedding");
		expect(embedMultilingual!.capabilities).toEqual(["embedding"]);
	});

	it("should classify rerank models with embedding mode and caps", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const rerank = cards.find((c) => c.id === "rerank-english-v3.0");
		expect(rerank!.mode).toBe("embedding");
		expect(rerank!.capabilities).toEqual(["embedding"]);
	});

	it("should throw on API error (401 unauthorized)", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 401,
				body: { message: "invalid api token" },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Cohere API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct card fields on all discovered models", async () => {
		mockFetch({
			"https://api.cohere.com/compatibility/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("cohere");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
			expect(card.originProvider).toBe("cohere");
		}
	});
});
