import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

function makeModel(overrides: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
	return {
		name: overrides.id,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing: { inputPerMillion: 1, outputPerMillion: 1 },
		...overrides,
	};
}

function makeProvider(
	id: string,
	name: string,
	models: ModelCard[],
	overrides?: Partial<ProviderInfo>,
): ProviderInfo {
	return {
		id,
		name,
		baseUrl: `https://api.${id}.com`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
		...overrides,
	};
}

const originalFetch = globalThis.fetch;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	restoreEnv("OPENAI_API_KEY", originalOpenAIKey);
	restoreEnv("AI_GATEWAY_API_KEY", originalGatewayKey);
	restoreEnv("VERCEL_OIDC_TOKEN", originalOidcToken);
});

describe("OpenAI-compatible proxy", () => {
	it("forwards Vercel OIDC credentials as bearer auth", async () => {
		delete process.env.AI_GATEWAY_API_KEY;
		process.env.VERCEL_OIDC_TOKEN = "oidc-test";

		const registry = ModelRegistry.fromJSON({
			providers: [
				makeProvider("vercel", "Vercel AI Gateway", [
					makeModel({
						id: "anthropic/claude-opus-4.6",
						provider: "vercel",
						pricing: { inputPerMillion: 5, outputPerMillion: 25 },
					}),
				], {
					baseUrl: "https://ai-gateway.vercel.sh/v1",
					authenticated: true,
				}),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const app = createServer(registry);
		const fetchMock = installFetchMock();

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-opus-4.6",
				messages: [{ role: "user", content: "hi" }],
			}),
		});

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oidc-test");
	});

	it("prefers credentialed routes for kosha:cheapest proxy routing", async () => {
		process.env.OPENAI_API_KEY = "openai-test";
		delete process.env.AI_GATEWAY_API_KEY;
		delete process.env.VERCEL_OIDC_TOKEN;

		const openaiModel = makeModel({
			id: "gpt-4o-mini",
			provider: "openai",
			pricing: { inputPerMillion: 10, outputPerMillion: 20 },
		});
		const vercelModel = makeModel({
			id: "xai/grok-cheap",
			provider: "vercel",
			pricing: { inputPerMillion: 0.01, outputPerMillion: 0.02 },
		});
		const registry = ModelRegistry.fromJSON({
			providers: [
				makeProvider("openai", "OpenAI", [openaiModel], { baseUrl: "https://api.openai.com" }),
				makeProvider("vercel", "Vercel AI Gateway", [vercelModel], {
					baseUrl: "https://ai-gateway.vercel.sh/v1",
					authenticated: false,
					credentialSource: "none",
				}),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const app = createServer(registry);
		const fetchMock = installFetchMock();

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "kosha:cheapest",
				messages: [{ role: "user", content: "hi" }],
			}),
		});

		expect(res.status).toBe(200);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.openai.com/v1/chat/completions");
		expect(JSON.parse(String(init?.body)).model).toBe("gpt-4o-mini");
	});
});

function installFetchMock() {
	const fetchMock = vi.fn(async () =>
		new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}
