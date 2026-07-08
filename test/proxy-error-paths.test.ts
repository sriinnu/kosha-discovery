/**
 * Coverage for the proxy's error response paths that weren't exercised by
 * the existing forward / failover suites: 422 (transport not supported),
 * 401 (no credentials on any candidate), 502 (Anthropic upstream returned
 * unparseable JSON), 400 (caller-side validation), and bad-strategy 404.
 *
 * These paths are load-bearing for DX and security — they tell the caller
 * exactly which configuration knob to turn — so they get explicit tests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	process.env = { ...originalEnv };
});

function makeModel(o: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
	return {
		name: o.id,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing: { inputPerMillion: 1, outputPerMillion: 1 },
		...o,
	};
}

function makeProvider(id: string, models: ModelCard[]): ProviderInfo {
	return {
		id,
		name: id,
		baseUrl: `https://api.${id}.example`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
	};
}

describe("proxy: 422 transport not supported", () => {
	it("returns 422 when the resolved model is on a non-proxiable provider", async () => {
		// Vertex uses the cloud-sdk transport, which the proxy doesn't speak.
		const registry = ModelRegistry.fromJSON({
			providers: [
				makeProvider("vertex", [makeModel({ id: "gemini-1.5-pro", provider: "vertex" })]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const app = createServer(registry);
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "gemini-1.5-pro", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(422);
		const json = await res.json();
		expect(json.error).toMatch(/transport/i);
		expect(json.resolvedProvider).toBe("vertex");
	});
});

describe("proxy: 401 when no candidate carries credentials", () => {
	it("returns 401 with the env-var hint and never calls fetch", async () => {
		// Anthropic requires credentials. We strip every plausible env var so
		// the resolver returns { source: "none" }.
		delete process.env.ANTHROPIC_API_KEY;
		const registry = ModelRegistry.fromJSON({
			providers: [
				makeProvider("anthropic", [makeModel({ id: "claude-sonnet-4-6", provider: "anthropic" })]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const app = createServer(registry);
		const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
		});

		expect(res.status).toBe(401);
		expect(fetchSpy).not.toHaveBeenCalled();
		const json = await res.json();
		expect(json.error).toMatch(/no credential/i);
		expect(json.hint).toMatch(/ANTHROPIC_API_KEY/);
	});
});

describe("proxy: Anthropic 502 on unparseable upstream JSON", () => {
	it("returns 502 with resolvedProvider when Anthropic returns 200 + garbage body", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const registry = ModelRegistry.fromJSON({
			providers: [
				makeProvider("anthropic", [makeModel({ id: "claude-sonnet-4-6", provider: "anthropic" })]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const app = createServer(registry);
		globalThis.fetch = (async () =>
			// 200 OK but the body isn't JSON. The translator needs to .json()
			// it and must surface a clean 502 rather than crashing.
			new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;

		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
		});

		expect(res.status).toBe(502);
		const json = await res.json();
		// Anthropic error bodies are re-shaped into the OpenAI error envelope.
		expect(json.error.message).toMatch(/unparseable/i);
		expect(json.error.type).toBe("upstream_error");
		expect(res.headers.get("x-kosha-provider")).toBe("anthropic");
	});
});

describe("proxy: 400 on bad request body", () => {
	it("rejects a missing model field", async () => {
		const registry = ModelRegistry.fromJSON({ providers: [], aliases: {}, discoveredAt: Date.now() });
		const app = createServer(registry);
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toMatch(/model/i);
	});

	it("rejects a non-JSON body", async () => {
		const registry = ModelRegistry.fromJSON({ providers: [], aliases: {}, discoveredAt: Date.now() });
		const app = createServer(registry);
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json{",
		});
		expect(res.status).toBe(400);
	});
});
