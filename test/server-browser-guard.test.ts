/**
 * Browser-facing defences on the default (loopback, token-less) server.
 *
 * Any web page can POST to http://127.0.0.1:3000 — a `text/plain` body skips
 * the CORS preflight and the proxy parses it as JSON anyway — and a
 * DNS-rebinding page can read the replies too. The guard refuses foreign
 * `Host` headers and cross-site requests; curl and SDKs send neither and pass.
 * Also covers the request-size bounds: body limit and `model` length.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../src/registry.js";
import { type CreateServerOptions, createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const saved = {
	KOSHA_PROXY_TOKEN: process.env.KOSHA_PROXY_TOKEN,
	KOSHA_ALLOWED_HOSTS: process.env.KOSHA_ALLOWED_HOSTS,
	KOSHA_MONTHLY_BUDGET_USD: process.env.KOSHA_MONTHLY_BUDGET_USD,
	GROQ_API_KEY: process.env.GROQ_API_KEY,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
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

function appWithGroq(
	models: ModelCard[] = [makeModel({ id: "llama-cheap", provider: "groq" })],
	options?: CreateServerOptions,
) {
	delete process.env.KOSHA_PROXY_TOKEN;
	process.env.GROQ_API_KEY = "groq-test";
	const provider: ProviderInfo = {
		id: "groq",
		name: "groq",
		baseUrl: "https://api.groq.com/openai/v1",
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
	};
	const registry = ModelRegistry.fromJSON({ providers: [provider], aliases: {}, discoveredAt: Date.now() });
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
	return createServer(registry, undefined, options);
}

const chatBody = JSON.stringify({ model: "llama-cheap", messages: [{ role: "user", content: "hi" }] });

function post(app: ReturnType<typeof createServer>, headers: Record<string, string>, body = chatBody) {
	return app.request("/proxy/v1/chat/completions", { method: "POST", headers, body });
}

describe("browser guard", () => {
	it("lets a plain client through (no Origin, loopback Host)", async () => {
		const app = appWithGroq();
		const res = await post(app, { host: "127.0.0.1:3000", "content-type": "application/json" });
		expect(res.status).toBe(200);
	});

	it("refuses a cross-site text/plain POST before anything is forwarded", async () => {
		const app = appWithGroq();
		const res = await post(app, {
			host: "127.0.0.1:3000",
			origin: "https://evil.example",
			"sec-fetch-site": "cross-site",
			"content-type": "text/plain",
		});
		expect(res.status).toBe(403);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("refuses an Origin that does not match Host, even without Sec-Fetch-Site", async () => {
		const app = appWithGroq();
		const res = await post(app, { host: "127.0.0.1:3000", origin: "https://evil.example" });
		expect(res.status).toBe(403);
	});

	it("refuses Origin: null (sandboxed frames, file://)", async () => {
		const app = appWithGroq();
		const res = await post(app, { host: "127.0.0.1:3000", origin: "null" });
		expect(res.status).toBe(403);
	});

	it("refuses a DNS-rebinding Host, reads included", async () => {
		const app = appWithGroq();
		const res = await app.request("/api/providers", { headers: { host: "rebind.evil.example:3000" } });
		expect(res.status).toBe(403);
	});

	it("accepts a same-origin request on every loopback spelling", async () => {
		const app = appWithGroq();
		for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000"]) {
			const res = await app.request("/api/providers", { headers: { host, origin: `http://${host}` } });
			expect(res.status, host).toBe(200);
		}
	});

	it("serves hosts listed in KOSHA_ALLOWED_HOSTS", async () => {
		process.env.KOSHA_ALLOWED_HOSTS = "kosha.internal, other.internal";
		const app = appWithGroq();
		const ok = await app.request("/api/providers", { headers: { host: "kosha.internal:8080" } });
		expect(ok.status).toBe(200);
		const no = await app.request("/api/providers", { headers: { host: "elsewhere.internal" } });
		expect(no.status).toBe(403);
	});

	it("skips the Host check with allowedHosts: 'any' but keeps the Origin check", async () => {
		const app = appWithGroq(undefined, { allowedHosts: "any" });
		const ok = await app.request("/api/providers", { headers: { host: "10.0.0.5:3000" } });
		expect(ok.status).toBe(200);
		const no = await app.request("/api/providers", {
			headers: { host: "10.0.0.5:3000", origin: "https://evil.example" },
		});
		expect(no.status).toBe(403);
	});
});

describe("request size bounds", () => {
	it("rejects a proxy body over the limit with 413", async () => {
		const app = appWithGroq();
		const huge = JSON.stringify({
			model: "llama-cheap",
			messages: [{ role: "user", content: "x".repeat(33 * 1024 * 1024) }],
		});
		const res = await post(app, { "content-type": "application/json" }, huge);
		expect(res.status).toBe(413);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("rejects an over-long model field fast, before the selector parser sees it", async () => {
		const app = appWithGroq();
		const started = Date.now();
		const res = await post(app, {}, JSON.stringify({ model: `kosha:${"[".repeat(200_000)}`, messages: [] }));
		expect(res.status).toBe(400);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("still parses a selector with filters", async () => {
		const app = appWithGroq();
		const res = await post(
			app,
			{},
			JSON.stringify({ model: "kosha:cheapest[provider:groq]", messages: [{ role: "user", content: "hi" }] }),
		);
		expect(res.status).toBe(200);
	});
});

describe("budget and unpriced routes", () => {
	const unpriced = [makeModel({ id: "llama-free-lunch", provider: "groq", pricing: undefined })];
	const body = JSON.stringify({ model: "llama-free-lunch", messages: [{ role: "user", content: "hi" }] });

	it("refuses an unpriced remote route while a budget is set (it would never reach the ledger)", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1000000";
		const app = appWithGroq(unpriced);
		const res = await post(app, {}, body);
		expect(res.status).toBe(422);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("forwards the same route when no budget is set", async () => {
		delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		const app = appWithGroq(unpriced);
		const res = await post(app, {}, body);
		expect(res.status).toBe(200);
	});
});

describe("$0 prices", () => {
	const zero = { inputPerMillion: 0, outputPerMillion: 0 };

	it("treats a remote $0/$0 route as unpriced under a budget", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "1000000";
		const app = appWithGroq([makeModel({ id: "llama-poisoned", provider: "groq", pricing: zero })]);
		const res = await post(
			app,
			{},
			JSON.stringify({ model: "llama-poisoned", messages: [{ role: "user", content: "hi" }] }),
		);
		expect(res.status).toBe(422);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("ranks a catalog-only $0 route after priced routes for kosha:cheapest", async () => {
		delete process.env.KOSHA_MONTHLY_BUDGET_USD;
		const app = appWithGroq([
			makeModel({ id: "llama-poisoned", provider: "groq", pricing: zero }),
			makeModel({ id: "llama-cheap", provider: "groq", pricing: { inputPerMillion: 0.05, outputPerMillion: 0.1 } }),
		]);
		const res = await post(
			app,
			{},
			JSON.stringify({ model: "kosha:cheapest", messages: [{ role: "user", content: "hi" }] }),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-kosha-model")).toBe("llama-cheap");
	});
});
