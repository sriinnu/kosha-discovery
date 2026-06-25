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
const originalGroqKey = process.env.GROQ_API_KEY;
const originalDeepinfraKey = process.env.DEEPINFRA_API_KEY;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	restoreEnv("OPENAI_API_KEY", originalOpenAIKey);
	restoreEnv("AI_GATEWAY_API_KEY", originalGatewayKey);
	restoreEnv("VERCEL_OIDC_TOKEN", originalOidcToken);
	restoreEnv("GROQ_API_KEY", originalGroqKey);
	restoreEnv("DEEPINFRA_API_KEY", originalDeepinfraKey);
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

	for (const strategy of ["fastest", "reliable", "balanced"] as const) {
		it(`recognizes the kosha:${strategy} selector and forwards`, async () => {
			process.env.OPENAI_API_KEY = "openai-test";
			delete process.env.AI_GATEWAY_API_KEY;
			delete process.env.VERCEL_OIDC_TOKEN;

			const registry = ModelRegistry.fromJSON({
				providers: [
					makeProvider("openai", "OpenAI", [
						makeModel({ id: "gpt-4o-mini", provider: "openai", pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
					], { baseUrl: "https://api.openai.com" }),
				],
				aliases: {},
				discoveredAt: Date.now(),
			});
			const app = createServer(registry);
			installFetchMock();

			const res = await app.request("/proxy/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: `kosha:${strategy}`, messages: [{ role: "user", content: "hi" }] }),
			});

			expect(res.status).toBe(200);
			expect(res.headers.get("x-kosha-model")).toBe("gpt-4o-mini");
		});
	}

	it("404s an unknown kosha:<strategy> selector instead of crashing", async () => {
		process.env.OPENAI_API_KEY = "openai-test";
		const registry = ModelRegistry.fromJSON({
			providers: [
				makeProvider("openai", "OpenAI", [makeModel({ id: "gpt-4o-mini", provider: "openai" })], {
					baseUrl: "https://api.openai.com",
				}),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const app = createServer(registry);
		installFetchMock();

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "kosha:turbofast", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(404);
	});
});

describe("proxy failover", () => {
	// groq (cheaper) is tried first under kosha:cheapest; deepinfra is the
	// fallback. Both are openai-compatible-http (forwardable). The mock keys
	// off the forwarded body.model so we never substring-match a URL host.
	function twoProviderRegistry() {
		process.env.GROQ_API_KEY = "g-test";
		process.env.DEEPINFRA_API_KEY = "d-test";
		return ModelRegistry.fromJSON({
			providers: [
				makeProvider("groq", "Groq", [
					makeModel({ id: "llama-cheap", provider: "groq", pricing: { inputPerMillion: 0.01, outputPerMillion: 0.02 } }),
				]),
				makeProvider("deepinfra", "DeepInfra", [
					makeModel({ id: "llama-mid", provider: "deepinfra", pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
				]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
	}

	/** Mock fetch that responds based on the forwarded model id. */
	function mockByModel(responder: (model: string) => { status: number } | "throw") {
		const fn = vi.fn(async (_url: string, init?: RequestInit) => {
			const model = JSON.parse(String(init?.body)).model as string;
			const out = responder(model);
			if (out === "throw") throw new Error("ECONNREFUSED");
			return new Response(JSON.stringify({ id: "x", choices: [] }), {
				status: out.status,
				headers: { "content-type": "application/json" },
			});
		});
		globalThis.fetch = fn as unknown as typeof fetch;
		return fn;
	}

	it("fails over to the next ranked provider on a 5xx", async () => {
		const app = createServer(twoProviderRegistry());
		mockByModel((m) => (m === "llama-cheap" ? { status: 503 } : { status: 200 }));

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "kosha:cheapest", messages: [{ role: "user", content: "hi" }] }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-provider")).toBe("deepinfra");
		expect(res.headers.get("x-kosha-model")).toBe("llama-mid");
		const chain = res.headers.get("x-kosha-attempt-chain") ?? "";
		expect(chain).toContain("groq:503");
		expect(chain).toContain("deepinfra:200");
	});

	it("fails over on a network error", async () => {
		const app = createServer(twoProviderRegistry());
		mockByModel((m) => (m === "llama-cheap" ? "throw" : { status: 200 }));

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "kosha:cheapest", messages: [{ role: "user", content: "hi" }] }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-provider")).toBe("deepinfra");
		expect(res.headers.get("x-kosha-attempt-chain")).toContain("groq:error");
	});

	it("refuses to forward to a host outside the catalog allowlist (SSRF guard)", async () => {
		// Simulate the threat: a poisoned cache or hand-edited config gives the
		// `openai` provider a baseUrl pointing at an attacker host. The proxy
		// must NOT dial that host, regardless of where the value came from.
		process.env.OPENAI_API_KEY = "openai-test";
		const registry = ModelRegistry.fromJSON({
			providers: [
				makeProvider("openai", "OpenAI", [
					makeModel({ id: "gpt-4o-mini", provider: "openai", pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
				], { baseUrl: "https://evil.example/v1" }),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const app = createServer(registry);
		const fn = installFetchMock();

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
		});

		// The catalog's openai defaultBaseUrl (api.openai.com) takes precedence
		// over the registry's baseUrl for non-local providers, so the request
		// still goes through. We verify the URL stays inside the allowlist.
		if (res.status === 200) {
			const [url] = fn.mock.calls[0];
			expect(new URL(String(url)).hostname).toBe("api.openai.com");
		} else {
			// If the descriptor didn't have a defaultBaseUrl, the proxy must
			// refuse rather than dial evil.example.
			expect(fn).not.toHaveBeenCalled();
			expect(res.status).toBe(502);
		}
	});

	it("reflects an x-kosha-estimated-cost-usd header on a successful forward", async () => {
		const app = createServer(twoProviderRegistry());
		mockByModel(() => ({ status: 200 }));

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "llama-cheap",
				messages: [{ role: "user", content: "x".repeat(350) }],
				max_tokens: 100,
			}),
		});

		expect(res.status).toBe(200);
		const cost = res.headers.get("x-kosha-estimated-cost-usd");
		expect(cost).toBeTruthy();
		// llama-cheap pricing: 0.01 in / 0.02 out per MTok.
		// ~100 input tokens (350 chars / 3.5) + 100 output tokens:
		//   100/1M*0.01 + 100/1M*0.02 = 1e-6 + 2e-6 = 3e-6
		expect(Number(cost)).toBeCloseTo(0.000003, 9);
	});

	it("does not fail over on a 4xx (caller error) and returns it as-is", async () => {
		const app = createServer(twoProviderRegistry());
		const fn = mockByModel((m) => (m === "llama-cheap" ? { status: 400 } : { status: 200 }));

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "kosha:cheapest", messages: [{ role: "user", content: "hi" }] }),
		});

		expect(res.status).toBe(400);
		expect(res.headers.get("x-kosha-provider")).toBe("groq");
		// Only the first provider should have been contacted.
		expect(fn).toHaveBeenCalledOnce();
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
