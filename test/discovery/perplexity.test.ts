import { afterEach, describe, expect, it } from "vitest";
import { PerplexityDiscoverer } from "../../src/discovery/perplexity.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchTimeout, restoreFetch } from "./mock-server.js";

const discoverer = new PerplexityDiscoverer();

const validCredential: CredentialResult = {
	apiKey: "pplx-test-key-abc123",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

const mockModelsResponse = {
	data: [
		{ id: "sonar-pro", object: "model", created: 1700000000, owned_by: "perplexity" },
		{ id: "sonar", object: "model", created: 1700000001, owned_by: "perplexity" },
		{ id: "sonar-deep-research", object: "model", created: 1700000002, owned_by: "perplexity" },
		{ id: "sonar-reasoning-pro", object: "model", created: 1700000003, owned_by: "perplexity" },
		{ id: "sonar-reasoning", object: "model", created: 1700000004, owned_by: "perplexity" },
		{ id: "r1-1776", object: "model", created: 1700000005, owned_by: "perplexity" },
	],
	object: "list",
};

afterEach(() => {
	restoreFetch();
});

describe("PerplexityDiscoverer", () => {
	it("should have correct provider metadata", () => {
		expect(discoverer.providerId).toBe("perplexity");
		expect(discoverer.providerName).toBe("Perplexity");
		expect(discoverer.baseUrl).toBe("https://api.perplexity.ai");
	});

	it("should return empty array when no API key provided", async () => {
		const result = await discoverer.discover(noCredential);
		expect(result).toEqual([]);
	});

	it("should discover all models in the catalog", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		expect(cards).toHaveLength(6);

		const ids = cards.map((c) => c.id);
		expect(ids).toContain("sonar-pro");
		expect(ids).toContain("sonar");
		expect(ids).toContain("sonar-deep-research");
		expect(ids).toContain("sonar-reasoning-pro");
		expect(ids).toContain("sonar-reasoning");
		expect(ids).toContain("r1-1776");
	});

	it("should set originProvider to perplexity for all models", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.originProvider).toBe("perplexity");
		}
	});

	it("should set mode to chat for all models", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.mode).toBe("chat");
		}
	});

	it("should include chat and function_calling for all models", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.capabilities).toContain("chat");
			expect(card.capabilities).toContain("function_calling");
		}
	});

	it("should add web_search capability to all sonar models", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const sonarModels = ["sonar-pro", "sonar", "sonar-deep-research", "sonar-reasoning-pro", "sonar-reasoning"];
		for (const id of sonarModels) {
			const card = cards.find((c) => c.id === id);
			expect(card!.capabilities).toContain("web_search");
		}

		// r1-1776 is not a sonar model — should not have web_search
		const r1 = cards.find((c) => c.id === "r1-1776");
		expect(r1!.capabilities).not.toContain("web_search");
	});

	it("should add nlu capability to pro models only", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		// sonar-pro and sonar-reasoning-pro are pro-tier
		const sonarPro = cards.find((c) => c.id === "sonar-pro");
		expect(sonarPro!.capabilities).toContain("nlu");

		const sonarReasoningPro = cards.find((c) => c.id === "sonar-reasoning-pro");
		expect(sonarReasoningPro!.capabilities).toContain("nlu");

		// Non-pro models should not have nlu
		const sonar = cards.find((c) => c.id === "sonar");
		expect(sonar!.capabilities).not.toContain("nlu");

		const sonarDeepResearch = cards.find((c) => c.id === "sonar-deep-research");
		expect(sonarDeepResearch!.capabilities).not.toContain("nlu");

		const sonarReasoning = cards.find((c) => c.id === "sonar-reasoning");
		expect(sonarReasoning!.capabilities).not.toContain("nlu");

		const r1 = cards.find((c) => c.id === "r1-1776");
		expect(r1!.capabilities).not.toContain("nlu");
	});

	it("should classify sonar-pro with both web_search and nlu", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const sonarPro = cards.find((c) => c.id === "sonar-pro");
		expect(sonarPro!.capabilities).toContain("chat");
		expect(sonarPro!.capabilities).toContain("function_calling");
		expect(sonarPro!.capabilities).toContain("web_search");
		expect(sonarPro!.capabilities).toContain("nlu");
	});

	it("should classify r1-1776 with only chat and function_calling", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		const r1 = cards.find((c) => c.id === "r1-1776");
		expect(r1!.capabilities).toEqual(["chat", "function_calling"]);
	});

	it("should throw on API error (401 Unauthorized)", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 401,
				body: { error: { message: "Invalid API key" } },
			},
		});

		await expect(discoverer.discover(validCredential)).rejects.toThrow("Perplexity API error: 401");
	});

	it("should throw on timeout", async () => {
		mockFetchTimeout();

		await expect(discoverer.discover(validCredential, { timeout: 50 })).rejects.toThrow("timed out");
	});

	it("should set correct card fields for all discovered models", async () => {
		mockFetch({
			"https://api.perplexity.ai/v1/models": {
				status: 200,
				body: mockModelsResponse,
			},
		});

		const cards = await discoverer.discover(validCredential);

		for (const card of cards) {
			expect(card.provider).toBe("perplexity");
			expect(card.source).toBe("api");
			expect(card.aliases).toEqual([]);
			expect(card.discoveredAt).toBeGreaterThan(0);
		}
	});
});
