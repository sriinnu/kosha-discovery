/**
 * The catalog-source switch: which keyless catalogs kosha may read, how the
 * env and config pick the mode, what a project config may not change, and
 * that `local` fails closed instead of drifting back to the network.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>();
	return { ...actual, default: { ...actual, homedir: () => home.dir }, homedir: () => home.dir };
});

const { getModelsDevSeed, getLiteLLMSeed } = vi.hoisted(() => ({
	getModelsDevSeed: vi.fn(async () => []),
	getLiteLLMSeed: vi.fn(async () => []),
}));
vi.mock("../src/discovery/modelsdev-seed.js", () => ({ getModelsDevSeed }));
vi.mock("../src/discovery/litellm-seed.js", () => ({ getLiteLLMSeed }));

import {
	assertCatalogReady,
	buildCatalogEnvelope,
	catalogCacheKey,
	configureCatalogSource,
	describeCatalog,
	resetCatalogSource,
	resolveCatalogSource,
} from "../src/catalog-source.js";
import { getPublicSeed } from "../src/discovery/public-seed.js";
import { parseSnapshotCatalog } from "../src/discovery/snapshot-catalog.js";
import { CatalogEnricher } from "../src/enrichment/catalog.js";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const ENV = ["KOSHA_CATALOG_SOURCE", "KOSHA_CATALOG_FILE"] as const;
const savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const savedCwd = process.cwd();
let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "kosha-catalog-"));
	home.dir = join(dir, "home");
	await import("node:fs/promises").then((fs) => fs.mkdir(home.dir));
	for (const name of ENV) delete process.env[name];
	resetCatalogSource();
	vi.clearAllMocks();
});

afterEach(async () => {
	process.chdir(savedCwd);
	for (const name of ENV) {
		if (savedEnv[name] === undefined) delete process.env[name];
		else process.env[name] = savedEnv[name];
	}
	resetCatalogSource();
	await rm(dir, { recursive: true, force: true });
});

function card(provider: string, id: string, extra: Partial<ModelCard> = {}): ModelCard {
	return {
		id,
		name: id,
		provider,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: 0,
		source: "litellm",
		...extra,
	};
}

function provider(id: string, models: ModelCard[]): ProviderInfo {
	return { id, name: id, baseUrl: `https://${id}.example`, authenticated: false, models, lastRefreshed: 0 };
}

async function writeCatalog(name: string, providers: ProviderInfo[], now = new Date("2026-10-20T00:00:00Z")) {
	const file = join(dir, name);
	await writeFile(file, JSON.stringify(buildCatalogEnvelope(providers, { discoveredAt: 1, now })));
	return file;
}

describe("resolveCatalogSource", () => {
	it("defaults to community", () => {
		expect(resolveCatalogSource()).toEqual({ mode: "community", origin: "default" });
	});

	it("takes the config, and lets the env override it", () => {
		configureCatalogSource({ catalogSource: "pinned" });
		expect(resolveCatalogSource()).toMatchObject({ mode: "pinned", origin: "config" });
		process.env.KOSHA_CATALOG_SOURCE = "community";
		expect(resolveCatalogSource()).toMatchObject({ mode: "community", origin: "env" });
	});

	it("refuses an unknown mode instead of quietly fetching", () => {
		process.env.KOSHA_CATALOG_SOURCE = "locl";
		expect(() => resolveCatalogSource()).toThrow(/not one of/);
	});

	it("requires a file in local mode", () => {
		process.env.KOSHA_CATALOG_SOURCE = "local";
		expect(() => resolveCatalogSource()).toThrow(/no catalog file/);
		process.env.KOSHA_CATALOG_FILE = "~/cat.json";
		expect(resolveCatalogSource().file).toBe(join(home.dir, "cat.json"));
	});

	it("keeps community cache keys as they were and scopes the others", () => {
		expect(catalogCacheKey("providers_all")).toBe("providers_all");
		process.env.KOSHA_CATALOG_SOURCE = "pinned";
		expect(catalogCacheKey("providers_all")).toBe("pinned_providers_all");
	});
});

describe("local mode", () => {
	it("seeds from the file and never calls the community catalogs", async () => {
		process.env.KOSHA_CATALOG_SOURCE = "local";
		process.env.KOSHA_CATALOG_FILE = await writeCatalog("cat.json", [provider("groq", [card("groq", "llama-x")])]);
		const cards = await getPublicSeed("groq");
		expect(cards.map((c) => [c.id, c.catalogSource])).toEqual([["llama-x", "local"]]);
		expect(getModelsDevSeed).not.toHaveBeenCalled();
		expect(getLiteLLMSeed).not.toHaveBeenCalled();
	});

	it("fails closed before discovery when the file is missing", async () => {
		process.env.KOSHA_CATALOG_SOURCE = "local";
		process.env.KOSHA_CATALOG_FILE = join(dir, "missing.json");
		await expect(assertCatalogReady()).rejects.toThrow(/not found/);
		const registry = new ModelRegistry({ cacheDir: join(dir, "cache") });
		await expect(registry.discover()).rejects.toThrow(/not found/);
	});

	it("reports the mode and the catalog's age for doctor", async () => {
		process.env.KOSHA_CATALOG_SOURCE = "local";
		process.env.KOSHA_CATALOG_FILE = await writeCatalog("cat.json", [provider("groq", [card("groq", "llama-x")])]);
		const report = await describeCatalog(Date.parse("2026-10-30T00:00:00Z"));
		expect(report).toMatchObject({ mode: "local", origin: "env", ageDays: 10 });
	});

	it("shows a broken setup in doctor instead of throwing", async () => {
		process.env.KOSHA_CATALOG_SOURCE = "local";
		process.env.KOSHA_CATALOG_FILE = join(dir, "missing.json");
		expect((await describeCatalog()).error).toMatch(/not found/);
	});
});

describe("parseSnapshotCatalog", () => {
	it("reads an export back as a catalog", () => {
		const envelope = buildCatalogEnvelope([provider("groq", [card("groq", "llama-x")])], {
			discoveredAt: 1,
			now: new Date("2026-10-20T00:00:00Z"),
		});
		expect(envelope).toMatchObject({ schemaVersion: 1, kind: "kosha-catalog", modelCount: 1, providerCount: 1 });
		const parsed = parseSnapshotCatalog(JSON.stringify(envelope), "test");
		expect(parsed.fetchedAt).toBe("2026-10-20T00:00:00.000Z");
		expect(parsed.providers.get("groq")?.map((c) => c.id)).toEqual(["llama-x"]);
	});

	it("still reads an older snapshot that has no kind or version", () => {
		const parsed = parseSnapshotCatalog(JSON.stringify({ providers: [provider("groq", [card("groq", "a")])] }), "test");
		expect(parsed.providers.get("groq")).toHaveLength(1);
		expect(parsed.fetchedAt).toBeNull();
	});

	it("refuses another kind or an unknown version", () => {
		expect(() => parseSnapshotCatalog(JSON.stringify({ kind: "other", providers: [] }), "test")).toThrow(
			/not a kosha catalog/,
		);
		expect(() =>
			parseSnapshotCatalog(JSON.stringify({ kind: "kosha-catalog", schemaVersion: 2, providers: [] }), "test"),
		).toThrow(/schemaVersion 2/);
	});
});

describe("CatalogEnricher", () => {
	it("fills missing prices and limits without overwriting API data", async () => {
		const catalog = parseSnapshotCatalog(
			JSON.stringify({
				providers: [
					provider("groq", [
						card("groq", "a", {
							pricing: { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 5 },
						}),
						card("groq", "b", { pricing: { inputPerMillion: 9, outputPerMillion: 9 }, contextWindow: 64_000 }),
					]),
				],
			}),
			"test",
		);
		const [a, b] = await new CatalogEnricher(catalog).enrich([
			card("groq", "a", { pricing: { inputPerMillion: 3, outputPerMillion: 4, cacheWritePerMillion: 3.75 } }),
			card("groq", "b", { contextWindow: 0 }),
		]);
		expect(a.pricing).toEqual({
			inputPerMillion: 3,
			outputPerMillion: 4,
			cacheReadPerMillion: 0.1,
			cacheWritePerMillion: 3.75,
		});
		expect(b.pricing).toEqual({ inputPerMillion: 9, outputPerMillion: 9 });
		expect(b.contextWindow).toBe(64_000);
	});
});

describe("loadConfigFile and the catalog", () => {
	async function project(config: object) {
		const repo = join(dir, "repo");
		await import("node:fs/promises").then((fs) => fs.mkdir(repo, { recursive: true }));
		await writeFile(join(repo, "kosha.config.json"), JSON.stringify(config));
		process.chdir(repo);
	}

	it("lets a project tighten community to pinned", async () => {
		await project({ catalogSource: "pinned" });
		expect((await ModelRegistry.loadConfigFile()).catalogSource).toBe("pinned");
	});

	it("ignores a project's local mode, catalog file and API keys", async () => {
		await project({
			catalogSource: "local",
			catalogFile: "/tmp/evil.json",
			providers: { openai: { apiKey: "sk-theirs", enabled: true } },
		});
		const config = await ModelRegistry.loadConfigFile();
		expect(config.catalogSource).toBeUndefined();
		expect(config.catalogFile).toBeUndefined();
		expect(config.providers?.openai).toEqual({ enabled: true });
	});

	it("never lets a project loosen a global local mode", async () => {
		await writeFile(
			join(home.dir, ".kosharc.json"),
			JSON.stringify({ catalogSource: "local", catalogFile: "~/c.json" }),
		);
		await project({ catalogSource: "pinned" });
		const config = await ModelRegistry.loadConfigFile();
		expect(config).toMatchObject({ catalogSource: "local", catalogFile: "~/c.json" });
	});
});
