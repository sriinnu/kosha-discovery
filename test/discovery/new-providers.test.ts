import { afterEach, describe, expect, it } from "vitest";
import type { CredentialResult } from "../../src/types.js";
import { DeepSeekDiscoverer } from "../../src/discovery/deepseek.js";
import { MoonshotDiscoverer } from "../../src/discovery/moonshot.js";
import { GLMDiscoverer } from "../../src/discovery/glm.js";
import { ZAIDiscoverer } from "../../src/discovery/zai.js";
import { MiniMaxDiscoverer } from "../../src/discovery/minimax.js";
import { mockFetch, restoreFetch } from "./mock-server.js";

const validCredential: CredentialResult = {
	apiKey: "test-api-key",
	source: "env",
};

const noCredential: CredentialResult = {
	source: "none",
};

afterEach(() => {
	restoreFetch();
});

describe("new first-class providers", () => {
	it("discovers DeepSeek models with context + limits", async () => {
		const discoverer = new DeepSeekDiscoverer();
		mockFetch({
			"https://api.deepseek.com/v1/models": {
				status: 200,
				body: {
					data: [
						{
							id: "deepseek-chat",
							object: "model",
							created: 1,
							owned_by: "deepseek",
							context_window: 131072,
							max_output_tokens: 8192,
							max_input_tokens: 131072,
						},
					],
					object: "list",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards).toHaveLength(1);
		expect(cards[0].provider).toBe("deepseek");
		expect(cards[0].originProvider).toBe("deepseek");
		expect(cards[0].contextWindow).toBe(131072);
		expect(cards[0].maxOutputTokens).toBe(8192);
		expect(cards[0].maxInputTokens).toBe(131072);
		expect(cards[0].capabilities).toContain("function_calling");
	});

	it("discovers Moonshot/Kimi models", async () => {
		const discoverer = new MoonshotDiscoverer();
		mockFetch({
			"https://api.moonshot.cn/v1/models": {
				status: 200,
				body: {
					data: [
						{
							id: "kimi-k2.5",
							object: "model",
							created: 1,
							owned_by: "moonshot",
							context_window: 262144,
						},
					],
					object: "list",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards).toHaveLength(1);
		expect(cards[0].provider).toBe("moonshot");
		expect(cards[0].capabilities).toContain("chat");
		expect(cards[0].capabilities).toContain("vision");
		expect(cards[0].contextWindow).toBe(262144);
	});

	it("discovers GLM models from /models endpoint", async () => {
		const discoverer = new GLMDiscoverer();
		mockFetch({
			"https://open.bigmodel.cn/api/paas/v4/models": {
				status: 200,
				body: {
					data: [
						{
							id: "glm-4-plus",
							object: "model",
							created: 1,
							owned_by: "zhipu",
							context_window: 128000,
						},
					],
					object: "list",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards).toHaveLength(1);
		expect(cards[0].provider).toBe("glm");
		expect(cards[0].originProvider).toBe("zhipu");
		expect(cards[0].capabilities).toContain("nlu");
	});

	it("discovers Z.AI models from /models endpoint", async () => {
		const discoverer = new ZAIDiscoverer();
		mockFetch({
			"https://api.z.ai/api/paas/v4/models": {
				status: 200,
				body: {
					data: [
						{
							id: "zai-thinking",
							object: "model",
							created: 1,
							owned_by: "zai",
						},
					],
					object: "list",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards).toHaveLength(1);
		expect(cards[0].provider).toBe("zai");
		expect(cards[0].capabilities).toContain("nlu");
	});

	it("discovers MiniMax models", async () => {
		const discoverer = new MiniMaxDiscoverer();
		mockFetch({
			"https://api.minimax.io/v1/models": {
				status: 200,
				body: {
					data: [
						{
							id: "minimax-text-01",
							object: "model",
							created: 1,
							owned_by: "minimax",
							context_window: 1000000,
						},
					],
					object: "list",
				},
			},
		});

		const cards = await discoverer.discover(validCredential);
		expect(cards).toHaveLength(1);
		expect(cards[0].provider).toBe("minimax");
		expect(cards[0].capabilities).toContain("function_calling");
		expect(cards[0].contextWindow).toBe(1000000);
	});

	it("returns empty array for no credentials", async () => {
		const discoverers = [
			new DeepSeekDiscoverer(),
			new MoonshotDiscoverer(),
			new GLMDiscoverer(),
			new ZAIDiscoverer(),
			new MiniMaxDiscoverer(),
		];

		for (const discoverer of discoverers) {
			const cards = await discoverer.discover(noCredential);
			expect(cards).toEqual([]);
		}
	});
});

