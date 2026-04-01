import { afterEach, describe, expect, it } from "vitest";
import { GLMDiscoverer } from "../../src/discovery/glm.js";
import { ZAIDiscoverer } from "../../src/discovery/zai.js";
import { getProviderDescriptor } from "../../src/provider-catalog.js";
import type { CredentialResult } from "../../src/types.js";

const validCredential: CredentialResult = {
	apiKey: "test-api-key",
	source: "env",
};

let restoreFetch: (() => void) | undefined;

afterEach(() => {
	restoreFetch?.();
	restoreFetch = undefined;
});

describe("provider contracts", () => {
	it("pins GLM discoverer base URL and /models fallback order", async () => {
		const discoverer = new GLMDiscoverer();
		expect(discoverer.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");

		const calls: string[] = [];
		restoreFetch = installFetchMock({
			"https://open.bigmodel.cn/api/paas/v4/models": {
				status: 404,
				body: { error: { message: "not found" } },
			},
			"https://open.bigmodel.cn/api/paas/v4/v1/models": {
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
		}, calls);

		const cards = await discoverer.discover(validCredential);

		expect(calls.slice(0, 3)).toEqual([
			"https://open.bigmodel.cn/api/paas/v4/models",
			"https://open.bigmodel.cn/api/paas/v4/models",
			"https://open.bigmodel.cn/api/paas/v4/models",
		]);
		expect(calls.at(-1)).toBe("https://open.bigmodel.cn/api/paas/v4/v1/models");
		expect(cards).toHaveLength(1);
		expect(cards[0].provider).toBe("glm");
		expect(cards[0].originProvider).toBe("zhipu");
	});

	it("pins Z.AI discoverer base URL and /models fallback order", async () => {
		const discoverer = new ZAIDiscoverer();
		expect(discoverer.baseUrl).toBe("https://api.z.ai/api/paas/v4");

		const calls: string[] = [];
		restoreFetch = installFetchMock({
			"https://api.z.ai/api/paas/v4/models": {
				status: 404,
				body: { error: { message: "not found" } },
			},
			"https://api.z.ai/api/paas/v4/v1/models": {
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
		}, calls);

		const cards = await discoverer.discover(validCredential);

		expect(calls.slice(0, 3)).toEqual([
			"https://api.z.ai/api/paas/v4/models",
			"https://api.z.ai/api/paas/v4/models",
			"https://api.z.ai/api/paas/v4/models",
		]);
		expect(calls.at(-1)).toBe("https://api.z.ai/api/paas/v4/v1/models");
		expect(cards).toHaveLength(1);
		expect(cards[0].provider).toBe("zai");
		expect(cards[0].originProvider).toBe("zai");
	});

	it("pins catalog transport and credential env vars for new providers", () => {
		expect(getProviderDescriptor("deepseek")).toMatchObject({
			transport: "openai-compatible-http",
			credentialEnvVars: ["DEEPSEEK_API_KEY"],
		});

		expect(getProviderDescriptor("moonshot")).toMatchObject({
			transport: "openai-compatible-http",
			credentialEnvVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
		});

		expect(getProviderDescriptor("glm")).toMatchObject({
			transport: "openai-compatible-http",
			credentialEnvVars: ["GLM_API_KEY", "ZHIPUAI_API_KEY"],
		});

		expect(getProviderDescriptor("zai")).toMatchObject({
			transport: "openai-compatible-http",
			credentialEnvVars: ["ZAI_API_KEY"],
		});

		expect(getProviderDescriptor("minimax")).toMatchObject({
			transport: "openai-compatible-http",
			credentialEnvVars: ["MINIMAX_API_KEY"],
		});
	});
});

function installFetchMock(
	responses: Record<string, { status: number; body: unknown }>,
	calls: string[],
): () => void {
	const originalFetch = globalThis.fetch;

	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;

		calls.push(url);

		const matchedKey = Object.keys(responses).find((key) => url.startsWith(key));
		if (!matchedKey) {
			throw new Error(`Unexpected fetch URL: ${url}`);
		}

		const response = responses[matchedKey];
		return {
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			statusText: statusTextForCode(response.status),
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => response.body,
			text: async () => JSON.stringify(response.body),
		} as Response;
	}) as typeof globalThis.fetch;

	return () => {
		globalThis.fetch = originalFetch;
	};
}

function statusTextForCode(code: number): string {
	const map: Record<number, string> = {
		200: "OK",
		404: "Not Found",
	};
	return map[code] ?? "Unknown";
}
