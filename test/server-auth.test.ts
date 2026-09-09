/**
 * Operator-token gate + bind-host defaults.
 *
 * `KOSHA_PROXY_TOKEN` protects the two surfaces that spend money or trigger
 * outbound work on the operator's behalf: `/proxy/*` and `POST /api/refresh`.
 * `resolveBindHost()` keeps `kosha serve` on loopback unless told otherwise.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../src/registry.js";
import { parseTenantTag } from "../src/proxy.js";
import { createServer, isLoopbackHost, proxyRequestAuthorized, resolveBindHost } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const originalToken = process.env.KOSHA_PROXY_TOKEN;
const originalHost = process.env.KOSHA_HOST;
const originalGroqKey = process.env.GROQ_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
	restoreEnv("KOSHA_PROXY_TOKEN", originalToken);
	restoreEnv("KOSHA_HOST", originalHost);
	restoreEnv("GROQ_API_KEY", originalGroqKey);
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

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

function makeProvider(id: string, models: ModelCard[], overrides?: Partial<ProviderInfo>): ProviderInfo {
	return {
		id,
		name: id,
		baseUrl: `https://api.${id}.com`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
		...overrides,
	};
}

function appWithGroq() {
	process.env.GROQ_API_KEY = "groq-test";
	const registry = ModelRegistry.fromJSON({
		providers: [
			makeProvider("groq", [makeModel({ id: "llama-cheap", provider: "groq" })], {
				baseUrl: "https://api.groq.com/openai/v1",
			}),
		],
		aliases: {},
		discoveredAt: Date.now(),
	});
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
	return createServer(registry);
}

const chatBody = JSON.stringify({ model: "llama-cheap", messages: [{ role: "user", content: "hi" }] });

describe("KOSHA_PROXY_TOKEN gate", () => {
	it("leaves the proxy open when no token is configured", async () => {
		delete process.env.KOSHA_PROXY_TOKEN;
		const app = appWithGroq();
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: chatBody,
		});
		expect(res.status).toBe(200);
	});

	it("rejects proxy requests without the token (401, OpenAI error envelope)", async () => {
		process.env.KOSHA_PROXY_TOKEN = "s3cret-token";
		const app = appWithGroq();
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: chatBody,
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { type: string; code: string } };
		expect(body.error.type).toBe("authentication_error");
		expect(body.error.code).toBe("401");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("rejects a wrong token and a same-length wrong token alike", async () => {
		process.env.KOSHA_PROXY_TOKEN = "s3cret-token";
		const app = appWithGroq();
		for (const bad of ["nope", "s3cret-tokeX"]) {
			const res = await app.request("/proxy/v1/models", { headers: { authorization: `Bearer ${bad}` } });
			expect(res.status).toBe(401);
		}
	});

	it("accepts the token as Authorization: Bearer", async () => {
		process.env.KOSHA_PROXY_TOKEN = "s3cret-token";
		const app = appWithGroq();
		const res = await app.request("/proxy/v1/models", { headers: { authorization: "Bearer s3cret-token" } });
		expect(res.status).toBe(200);
	});

	it("accepts the token via x-kosha-token so Authorization can carry the tenant tag", async () => {
		process.env.KOSHA_PROXY_TOKEN = "s3cret-token";
		const app = appWithGroq();
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-kosha-token": "s3cret-token",
				authorization: "Bearer kosha-tenant-acme",
			},
			body: chatBody,
		});
		expect(res.status).toBe(200);
	});

	it("gates POST /api/refresh but leaves read-only API routes open", async () => {
		process.env.KOSHA_PROXY_TOKEN = "s3cret-token";
		const app = appWithGroq();
		const refresh = await app.request("/api/refresh", { method: "POST" });
		expect(refresh.status).toBe(401);
		const models = await app.request("/api/models");
		expect(models.status).toBe(200);
		const health = await app.request("/health");
		expect(health.status).toBe(200);
	});

	it("proxyRequestAuthorized() is a pure predicate over headers", () => {
		process.env.KOSHA_PROXY_TOKEN = "abc";
		const headers = (map: Record<string, string>) => ({ get: (n: string) => map[n.toLowerCase()] ?? null });
		expect(proxyRequestAuthorized(headers({}))).toBe(false);
		expect(proxyRequestAuthorized(headers({ authorization: "Bearer abc" }))).toBe(true);
		expect(proxyRequestAuthorized(headers({ authorization: "bearer   abc  " }))).toBe(true);
		expect(proxyRequestAuthorized(headers({ "x-kosha-token": "abc" }))).toBe(true);
		expect(proxyRequestAuthorized(headers({ "x-kosha-token": "ab" }))).toBe(false);
		expect(proxyRequestAuthorized(headers({ authorization: "Bearer" }))).toBe(false);
		expect(proxyRequestAuthorized(headers({ authorization: "Bearer\tabc" }))).toBe(true);
		expect(proxyRequestAuthorized(headers({ authorization: "Bearerabc" }))).toBe(false);
		// A pathological header must be rejected quickly (the parser is regex-free).
		const started = performance.now();
		expect(proxyRequestAuthorized(headers({ authorization: `Bearer a${" ".repeat(16_000)}b` }))).toBe(false);
		expect(performance.now() - started).toBeLessThan(50);
		delete process.env.KOSHA_PROXY_TOKEN;
		expect(proxyRequestAuthorized(headers({}))).toBe(true);
	});
});

describe("tenant tag carriers", () => {
	it("prefers x-kosha-tenant, falls back to the legacy bearer form", () => {
		expect(parseTenantTag("Bearer kosha-tenant-legacy", undefined)).toBe("legacy");
		expect(parseTenantTag("Bearer s3cret-token", "acme")).toBe("acme");
		expect(parseTenantTag("Bearer kosha-tenant-legacy", "acme")).toBe("acme");
		expect(parseTenantTag(undefined, undefined)).toBeNull();
	});

	it("rejects malformed tenant headers instead of writing them to the ledger", () => {
		expect(parseTenantTag(undefined, "has space")).toBeNull();
		expect(parseTenantTag(undefined, "a".repeat(65))).toBeNull();
		expect(parseTenantTag(undefined, "new\nline")).toBeNull();
	});
});

describe("resolveBindHost()", () => {
	it("defaults to loopback", () => {
		delete process.env.KOSHA_HOST;
		expect(resolveBindHost()).toBe("127.0.0.1");
		expect(resolveBindHost("")).toBe("127.0.0.1");
		expect(resolveBindHost("   ")).toBe("127.0.0.1");
	});

	it("honours an explicit host over KOSHA_HOST over the default", () => {
		process.env.KOSHA_HOST = "10.0.0.5";
		expect(resolveBindHost()).toBe("10.0.0.5");
		expect(resolveBindHost("0.0.0.0")).toBe("0.0.0.0");
	});

	it("classifies loopback vs network binds", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("192.168.1.20")).toBe(false);
	});
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}
