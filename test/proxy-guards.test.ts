/**
 * Guards that must fail when the code they protect is removed: the proxy's
 * upstream host allowlist (SSRF) and the budget gate's fail-closed path on an
 * unreadable ledger. Each test was checked against a mutant with the guard
 * deleted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeUpstreamUrl } from "../src/proxy.js";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

function model(id: string, provider: string, pricing = { inputPerMillion: 1, outputPerMillion: 1 }): ModelCard {
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
		pricing,
	};
}

function provider(id: string, models: ModelCard[], baseUrl: string): ProviderInfo {
	return {
		id,
		name: id,
		baseUrl,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
	};
}

function okFetch() {
	const fn = vi.fn(
		async () =>
			new Response(JSON.stringify({ id: "x", choices: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	globalThis.fetch = fn as unknown as typeof fetch;
	return fn;
}

function chat(app: ReturnType<typeof createServer>, modelId: string) {
	return app.request("/proxy/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }] }),
	});
}

const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	for (const k of ["OPENAI_API_KEY", "KOSHA_MONTHLY_BUDGET_USD", "KOSHA_LEDGER_PATH"]) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe("safeUpstreamUrl", () => {
	it("accepts a catalog host and refuses any other remote host", () => {
		expect(safeUpstreamUrl("https://api.openai.com/v1/chat/completions", false)?.hostname).toBe("api.openai.com");
		expect(safeUpstreamUrl("https://evil.example/v1/chat/completions", false)).toBeNull();
		// A catalog host as a subdomain of an attacker host is not the catalog host.
		expect(safeUpstreamUrl("https://api.openai.com.evil.example/v1", false)).toBeNull();
	});

	it("keeps local runtimes on loopback, including bracketed IPv6", () => {
		expect(safeUpstreamUrl("http://127.0.0.1:11434/v1/chat/completions", true)).not.toBeNull();
		expect(safeUpstreamUrl("http://localhost:11434/v1/chat/completions", true)).not.toBeNull();
		expect(safeUpstreamUrl("http://[::1]:11434/v1/chat/completions", true)).not.toBeNull();
		expect(safeUpstreamUrl("http://evil.example:11434/v1/chat/completions", true)).toBeNull();
		expect(safeUpstreamUrl("http://10.0.0.5:11434/v1/chat/completions", true)).toBeNull();
	});

	it("refuses non-http schemes", () => {
		expect(safeUpstreamUrl("file:///etc/passwd", true)).toBeNull();
		expect(safeUpstreamUrl("data:text/plain,hi", false)).toBeNull();
		expect(safeUpstreamUrl("not a url", false)).toBeNull();
	});
});

describe("proxy SSRF guard end to end", () => {
	it("never dials a local provider whose baseUrl points off loopback", async () => {
		const registry = ModelRegistry.fromJSON({
			providers: [
				provider(
					"ollama",
					[model("llama3", "ollama", { inputPerMillion: 0, outputPerMillion: 0 })],
					"https://evil.example",
				),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const fn = okFetch();
		const res = await chat(createServer(registry), "llama3");
		expect(fn).not.toHaveBeenCalled();
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.headers.get("x-kosha-attempt-chain") ?? JSON.stringify(await res.json())).toContain("untrusted-host");
	});
});

describe("budget gate fails closed", () => {
	it("returns 503 and forwards nothing when the ledger cannot be read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kosha-ledger-dir-"));
		try {
			// A directory where the ledger file should be: readFile throws EISDIR, not ENOENT.
			process.env.KOSHA_LEDGER_PATH = dir;
			process.env.KOSHA_MONTHLY_BUDGET_USD = "10";
			process.env.OPENAI_API_KEY = "openai-test";
			const registry = ModelRegistry.fromJSON({
				providers: [provider("openai", [model("gpt-4o-mini", "openai")], "https://api.openai.com/v1")],
				aliases: {},
				discoveredAt: Date.now(),
			});
			const fn = okFetch();
			const res = await chat(createServer(registry), "gpt-4o-mini");
			expect(res.status).toBe(503);
			expect(fn).not.toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
