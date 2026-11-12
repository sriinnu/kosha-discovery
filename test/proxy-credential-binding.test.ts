/**
 * The proxy sends a key only where discovery verified it, takes config keys
 * like discovery does, never forwards a Claude subscription OAuth token, and
 * builds each provider's real chat-completions path.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_PLAN_CAPABILITY } from "../src/discovery/free-tier.js";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

function model(id: string, provider: string, pricing?: ModelCard["pricing"]): ModelCard {
	return {
		id,
		name: id,
		provider,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing: pricing ?? { inputPerMillion: 1, outputPerMillion: 2 },
	};
}

function provider(id: string, models: ModelCard[], baseUrl: string, authenticated = true): ProviderInfo {
	return {
		id,
		name: id,
		baseUrl,
		authenticated,
		credentialSource: authenticated ? "env" : "none",
		models,
		lastRefreshed: Date.now(),
	};
}

function registryOf(providers: ProviderInfo[]) {
	return ModelRegistry.fromJSON({ providers, aliases: {}, discoveredAt: Date.now() });
}

function post(app: ReturnType<typeof createServer>, modelId: string) {
	return app.request("/proxy/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }] }),
	});
}

type Call = { url: string; auth: string | null };
function recordingFetch(respond: (url: string) => Response) {
	const calls: Call[] = [];
	globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
		const headers = new Headers(init.headers);
		calls.push({ url: String(url), auth: headers.get("authorization") ?? headers.get("x-api-key") });
		return respond(String(url));
	}) as unknown as typeof fetch;
	return calls;
}

const ok = () =>
	new Response(JSON.stringify({ id: "x", choices: [] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const ENV = ["MOONSHOT_API_KEY", "ZAI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("a shared key goes only where discovery verified it", () => {
	it("doesn't fail over to a sibling region that never accepted the key", async () => {
		process.env.MOONSHOT_API_KEY = "sk-intl-key";
		const app = createServer(
			registryOf([
				provider("moonshot", [model("kimi-k2", "moonshot")], "https://api.moonshot.ai"),
				provider("moonshot-cn", [model("kimi-k2", "moonshot-cn")], "https://api.moonshot.cn", false),
			]),
		);
		const calls = recordingFetch(() => new Response("down", { status: 503 }));
		const res = await post(app, "kimi-k2");
		expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["api.moonshot.ai"]);
		expect(res.headers.get("x-kosha-attempt-chain") ?? JSON.stringify(await res.json())).toContain(
			"moonshot-cn:unverified-shared-key",
		);
	});

	it("fails over from a plan that refuses a shared pay-as-you-go key to the paid route", async () => {
		process.env.ZAI_API_KEY = "zai-payg";
		const app = createServer(
			registryOf([
				provider(
					"zai-coding-plan",
					[
						{
							...model("glm-4.6", "zai-coding-plan"),
							pricing: undefined,
							rawCapabilities: [SUBSCRIPTION_PLAN_CAPABILITY],
						},
					],
					"https://api.z.ai/api/coding/paas/v4",
				),
				provider("zai", [model("glm-4.6", "zai")], "https://api.z.ai/api/paas/v4"),
			]),
		);
		const calls = recordingFetch((url) => (url.includes("/coding/") ? new Response("no plan", { status: 401 }) : ok()));
		const res = await post(app, "glm-4.6");
		expect(calls.map((c) => c.url)).toEqual([
			"https://api.z.ai/api/coding/paas/v4/chat/completions",
			"https://api.z.ai/api/paas/v4/chat/completions",
		]);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-provider")).toBe("zai");
	});
});

describe("keys from config", () => {
	it("forwards providers.<id>.apiKey, as discovery uses it", async () => {
		const registry = new ModelRegistry({ providers: { groq: { apiKey: "cfg-key" } } });
		// Seed the discovered state directly: discovery itself is out of scope here.
		(registry as unknown as { state: { providerMap: Map<string, ProviderInfo> } }).state.providerMap.set(
			"groq",
			provider("groq", [model("llama-cheap", "groq")], "https://api.groq.com/openai/v1"),
		);
		const calls = recordingFetch(ok);
		const res = await post(createServer(registry), "llama-cheap");
		expect(res.status).toBe(200);
		expect(calls[0].auth).toBe("Bearer cfg-key");
	});
});

describe("Claude subscription OAuth", () => {
	it("is not forwarded as an API key", async () => {
		mkdirSync(join(homedir(), ".claude"), { recursive: true });
		writeFileSync(join(homedir(), ".claude", "credentials.json"), JSON.stringify({ accessToken: "oauth-token" }));
		delete process.env.ANTHROPIC_API_KEY;
		const app = createServer(
			registryOf([provider("anthropic", [model("claude-x", "anthropic")], "https://api.anthropic.com")]),
		);
		const calls = recordingFetch(ok);
		await post(app, "claude-x");
		expect(calls.some((c) => c.auth?.includes("oauth-token"))).toBe(false);
	});
});

describe("chat-completions paths", () => {
	it("uses /v1 for roots that serve it there", async () => {
		process.env.MOONSHOT_API_KEY = "sk-intl-key";
		const app = createServer(
			registryOf([provider("moonshot", [model("kimi-k2", "moonshot")], "https://api.moonshot.ai")]),
		);
		const calls = recordingFetch(ok);
		await post(app, "kimi-k2");
		expect(calls[0].url).toBe("https://api.moonshot.ai/v1/chat/completions");
	});

	it("doesn't double /v1 on a local base that already has it", async () => {
		const app = createServer(
			registryOf([
				provider(
					"lmstudio",
					[model("qwen-local", "lmstudio", { inputPerMillion: 0, outputPerMillion: 0 })],
					"http://127.0.0.1:1234/v1",
				),
			]),
		);
		const calls = recordingFetch(ok);
		await post(app, "qwen-local");
		expect(calls[0].url).toBe("http://127.0.0.1:1234/v1/chat/completions");
	});

	it("keeps a path-bearing base as it is", async () => {
		process.env.GROQ_API_KEY = "g";
		const app = createServer(
			registryOf([provider("groq", [model("llama-cheap", "groq")], "https://api.groq.com/openai/v1")]),
		);
		const calls = recordingFetch(ok);
		await post(app, "llama-cheap");
		expect(calls[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
	});
});
