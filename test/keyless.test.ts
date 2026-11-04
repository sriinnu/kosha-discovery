import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModelsDevCatalogCache } from "../src/discovery/modelsdev-catalog.js";
import { ModelRegistry } from "../src/registry.js";

const cli = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof import("node:child_process")>();
	const record = (command: string) => {
		cli.calls.push(command);
		throw new Error("no CLI in this test");
	};
	return { ...real, execSync: record, execFileSync: record };
});

const PLANTED = ["planted", "fake", "credential"].join(".");

describe("keyless discovery", () => {
	const requests: { url: string; headers: string }[] = [];

	beforeEach(() => {
		requests.length = 0;
		cli.calls.length = 0;
		resetModelsDevCatalogCache();
		for (const name of [
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"OPENROUTER_API_KEY",
			"GROQ_API_KEY",
			"DEEPSEEK_API_KEY",
		]) {
			vi.stubEnv(name, PLANTED);
		}
		vi.stubEnv("KOSHA_CATALOG_SOURCE", "");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({
					url: String(input instanceof Request ? input.url : input),
					headers: JSON.stringify(Object.fromEntries(new Headers(init?.headers).entries())),
				});
				return new Response("", { status: 404 });
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		resetModelsDevCatalogCache();
	});

	const discover = async (keyless: boolean) => {
		const home = mkdtempSync(join(tmpdir(), "kosha-keyless-"));
		const registry = new ModelRegistry({
			cacheDir: join(home, "cache"),
			keyless,
			providers: { groq: { apiKey: PLANTED } },
		});
		await registry.discover({ force: true, enrichWithPricing: false, includeLocal: false });
		return registry;
	};

	it("sends no credential, even one set in config, and runs no cloud CLI", async () => {
		const registry = await discover(true);
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.filter((r) => r.headers.includes(PLANTED) || r.url.includes(PLANTED))).toEqual([]);
		expect(requests.filter((r) => /authorization|x-api-key|api-key/i.test(r.headers))).toEqual([]);
		expect(cli.calls).toEqual([]);
		for (const provider of registry.providers_list()) {
			expect(provider.authenticated).toBe(false);
		}
	});

	it("would have sent them without it, so the test above can fail", async () => {
		await discover(false);
		expect(requests.some((r) => r.headers.includes(PLANTED) || r.url.includes(PLANTED))).toBe(true);
	});
});
