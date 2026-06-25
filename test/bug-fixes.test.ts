/**
 * Regression tests for the batch of correctness/security fixes:
 *  - Google API key travels in a header, never the URL.
 *  - Discovery requests carry a default User-Agent (caller can override).
 *  - KoshaCache refuses to parse an oversized cache file.
 *  - Anthropic pagination is bounded by a hard page cap.
 *  - The proxy strips control characters from the reflected x-kosha-requested.
 */

import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KoshaCache } from "../src/cache.js";
import { AnthropicDiscoverer } from "../src/discovery/anthropic.js";
import { GoogleDiscoverer } from "../src/discovery/google.js";
import { createServer } from "../src/server.js";
import { ModelRegistry } from "../src/registry.js";
import type { CredentialResult, ModelCard, ProviderInfo } from "../src/types.js";
import { resetLiteLLMCatalogCache } from "../src/enrichment/litellm-catalog.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	resetLiteLLMCatalogCache();
});

/** Capture every fetch call's url + headers and return a canned JSON body. */
function captureFetch(body: unknown) {
	const calls: { url: string; headers: Headers }[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, headers: new Headers(init?.headers) });
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof globalThis.fetch;
	return calls;
}

describe("Google discoverer: key never in URL", () => {
	const credential: CredentialResult = { apiKey: "AIzaSy-secret-123", source: "env" };

	it("sends the API key via x-goog-api-key header, not the query string", async () => {
		const calls = captureFetch({ models: [], nextPageToken: undefined });
		await new GoogleDiscoverer().discover(credential, { timeout: 2_000 });

		// Only the Google models endpoint carries the credential; the public
		// seed / enrichment fetches go elsewhere and are not relevant here.
		const googleCalls = calls.filter((c) => c.url.includes("generativelanguage.googleapis.com"));
		expect(googleCalls.length).toBeGreaterThan(0);
		for (const call of googleCalls) {
			expect(call.url).not.toContain("key=");
			expect(call.url).not.toContain("AIzaSy-secret-123");
			expect(call.headers.get("x-goog-api-key")).toBe("AIzaSy-secret-123");
		}
	});

	it("attaches a default User-Agent to discovery requests", async () => {
		const calls = captureFetch({ models: [], nextPageToken: undefined });
		await new GoogleDiscoverer().discover(credential, { timeout: 2_000 });
		const googleCall = calls.find((c) => c.url.includes("generativelanguage.googleapis.com"));
		expect(googleCall?.headers.get("user-agent")).toMatch(/kosha-discovery/);
	});
});

describe("KoshaCache: oversized-file guard", () => {
	let dir: string;
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns null and invalidates a cache file beyond the size ceiling", async () => {
		dir = await mkdtemp(join(tmpdir(), "kosha-bomb-"));
		const cache = new KoshaCache(dir);
		// 26 MB of valid-ish JSON, above the 25 MB ceiling.
		const huge = `{"data":"${"x".repeat(26 * 1024 * 1024)}","timestamp":1}`;
		await writeFile(join(dir, "providers_all.json"), huge, "utf-8");

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const entry = await cache.get("providers_all");
		expect(entry).toBeNull();
		expect(warn).toHaveBeenCalled();
		// File should have been invalidated (a subsequent read is a clean miss).
		expect(await cache.get("providers_all")).toBeNull();
	});
});

describe("Anthropic discoverer: pagination is bounded", () => {
	it("throws rather than looping forever when has_more never clears", async () => {
		// Every page reports has_more:true with a fresh cursor but no models,
		// so the model-count cap never trips — only the page cap can stop it.
		let page = 0;
		globalThis.fetch = (async () => {
			page += 1;
			return new Response(
				JSON.stringify({ data: [], has_more: true, first_id: null, last_id: `cursor-${page}` }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		await expect(
			new AnthropicDiscoverer().discover({ apiKey: "sk-ant-test", source: "env" }, { timeout: 5_000 }),
		).rejects.toThrow(/pagination exceeded/i);
	});
});

describe("Proxy: x-kosha-requested is sanitized", () => {
	it("strips CR/LF from the reflected requested-model header", async () => {
		const model: ModelCard = {
			id: "gpt-4o-mini",
			name: "gpt-4o-mini",
			provider: "openai",
			mode: "chat",
			capabilities: ["chat"],
			contextWindow: 128_000,
			maxOutputTokens: 8_192,
			aliases: [],
			discoveredAt: Date.now(),
			source: "manual",
			pricing: { inputPerMillion: 1, outputPerMillion: 1 },
		};
		const provider: ProviderInfo = {
			id: "openai",
			name: "OpenAI",
			baseUrl: "https://api.openai.com",
			authenticated: true,
			credentialSource: "env",
			models: [model],
			lastRefreshed: Date.now(),
		};
		const registry = ModelRegistry.fromJSON({ providers: [provider], aliases: {}, discoveredAt: Date.now() });
		const app = createServer(registry);
		process.env.OPENAI_API_KEY = "openai-test";
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ id: "x", choices: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		// The `kosha:cheapest` selector matches by prefix, so a CRLF-injection
		// suffix still resolves to a real model while leaving control chars in
		// the reflected `requested` string — the exact path that used to 500.
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "kosha:cheapest\r\nx-injected: 1",
				messages: [{ role: "user", content: "hi" }],
			}),
		});

		// The request must not 500, and the reflected header must be free of CRLF.
		expect(res.status).toBe(200);
		const reflected = res.headers.get("x-kosha-requested") ?? "";
		expect(reflected).not.toMatch(/[\r\n]/);
	});
});
