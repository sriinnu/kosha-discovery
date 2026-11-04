import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELSDEV_CATALOG_URL, resetModelsDevCatalogCache } from "../src/discovery/modelsdev-catalog.js";
import { PROVIDER_CATALOG } from "../src/provider-catalog.js";
import { ModelRegistry } from "../src/registry.js";

const model = (id: string, input: number, output: number) => ({
	id,
	name: id,
	cost: { input, output },
	limit: { context: 100_000, output: 8_000 },
	modalities: { input: ["text"], output: ["text"] },
});

const models = (...entries: ReturnType<typeof model>[]) =>
	Object.fromEntries(entries.map((entry) => [entry.id, entry]));

const CATALOG = {
	opencode: {
		id: "opencode",
		name: "OpenCode",
		api: "https://opencode.ai/inference/openai/v1",
		env: ["OPENCODE_API_KEY"],
		models: models(model("beam-free", 0, 0), model("pulse-alpha-free", 0, 0), model("catalog-cheap", 0.001, 0.001)),
	},
	"opencode-go": { id: "opencode-go", name: "OpenCode Go", models: models(model("kimi-k3.1-pro", 2, 10)) },
	"zai-coding-plan": { id: "zai-coding-plan", name: "Z.AI Coding Plan", models: models(model("glm-plan", 0, 0)) },
	gitlab: { id: "gitlab", name: "GitLab", models: models(model("duo-chat-fable-5", 0, 0)) },
	"brand-new-host": { id: "brand-new-host", name: "Brand New", models: models(model("shared-model", 0.01, 0.01)) },
	"Bad Slug!": { id: "bad", models: models(model("hidden", 1, 1)) },
	nvidia: { id: "nvidia", name: "NVIDIA", models: models(model("nvidia-mapped", 2, 2)) },
	openrouter: { id: "openrouter", name: "OpenRouter", models: models(model("from-catalog-not-live", 3, 3)) },
	deepseek: { id: "deepseek", name: "DeepSeek", models: models(model("shared-model", 5, 5)) },
};

function stubFetch(catalogResponse: () => Response): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url === MODELSDEV_CATALOG_URL) return catalogResponse();
			// A 404 fails at once. Throwing would look like a network failure, which
			// the discoverers retry with backoff.
			return new Response("", { status: 404 });
		}),
	);
}

interface Row {
	key: string;
	providerId: string;
	modelId: string;
	canonicalProviderId: string;
	pricing: { inputPerMillion: number; outputPerMillion: number } | null;
	capabilities: string[];
	rawCapabilities: string[];
}

async function discovered(home = mkdtempSync(join(tmpdir(), "kosha-catalog-only-"))) {
	// Only the built-ins these tests read. The rest shell out to cloud CLIs or fetch
	// for nothing, which pushed a discovery past the 10s test limit on a CI runner.
	const providers = Object.fromEntries(
		PROVIDER_CATALOG.filter((p) => p.providerId !== "deepseek" && p.providerId !== "nvidia").map((p) => [
			p.providerId,
			{ enabled: false },
		]),
	);
	const registry = new ModelRegistry({ cacheDir: join(home, "cache"), providers });
	await registry.discover({ force: true, enrichWithPricing: false, includeLocal: false });
	const read = (name: string) =>
		existsSync(join(home, name)) ? (JSON.parse(readFileSync(join(home, name), "utf-8")) as { models: Row[] }) : null;
	return { registry, home, catalogOnly: read("catalog-only.json"), manifest: read("registry.json") };
}

describe("catalog-only providers", () => {
	beforeEach(() => {
		resetModelsDevCatalogCache();
		vi.stubEnv("KOSHA_CATALOG_SOURCE", "");
		stubFetch(() => new Response(JSON.stringify(CATALOG)));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		resetModelsDevCatalogCache();
	});

	const row = (rows: Row[] | undefined, key: string) => rows?.find((r) => r.key === key);

	it("saves an unmapped provider's models, free and paid, to their own file", async () => {
		const { catalogOnly } = await discovered();
		for (const key of ["opencode:beam-free", "opencode:pulse-alpha-free"]) {
			expect(row(catalogOnly?.models, key)?.pricing).toMatchObject({ inputPerMillion: 0, outputPerMillion: 0 });
			expect(row(catalogOnly?.models, key)?.capabilities).toContain("free_tier");
		}
		expect(row(catalogOnly?.models, "opencode-go:kimi-k3.1-pro")?.pricing).toMatchObject({
			inputPerMillion: 2,
			outputPerMillion: 10,
		});
		expect(row(catalogOnly?.models, "opencode:beam-free")?.canonicalProviderId).toBe("models.dev");
	});

	it("keeps every row out of the registry, the cache and the runtime", async () => {
		const { registry, manifest, home } = await discovered();
		const providers = new Set(manifest?.models.map((m) => m.providerId));
		for (const hidden of ["opencode", "opencode-go", "zai-coding-plan", "gitlab", "brand-new-host"]) {
			expect(providers).not.toContain(hidden);
			expect(registry.models({ provider: hidden })).toEqual([]);
		}
		const cacheFiles = readdirSync(join(home, "cache"));
		expect(cacheFiles.some((name) => /opencode|gitlab|brand-new-host|coding-plan/.test(name))).toBe(false);
		for (const name of cacheFiles) {
			expect(readFileSync(join(home, "cache", name), "utf-8")).not.toContain("beam-free");
		}
		expect(registry.model("catalog-cheap")).toBeUndefined();
		expect(registry.model("shared-model")?.provider).toBe("deepseek");
		const cheapest = registry.cheapestModels({ limit: 500, includeUnpriced: true });
		expect(cheapest.matches.map((m) => m.model.provider)).not.toContain("opencode");
	});

	it("doesn't read a subscription plan's $0 as free", async () => {
		const { catalogOnly } = await discovered();
		const plan = row(catalogOnly?.models, "zai-coding-plan:glm-plan");
		expect(plan).toBeDefined();
		expect(plan?.pricing).toBeNull();
		expect(plan?.capabilities).not.toContain("free_tier");
		expect(plan?.rawCapabilities).toContain("subscription_plan");
	});

	it("reads GitLab Duo's $0 as a seat, not as free", async () => {
		const { catalogOnly } = await discovered();
		const duo = row(catalogOnly?.models, "gitlab:duo-chat-fable-5");
		expect(duo?.pricing).toBeNull();
		expect(duo?.capabilities).not.toContain("free_tier");
		expect(duo?.rawCapabilities).toContain("subscription_plan");
	});

	it("picks up a new catalog slug with no code change, and rejects an unsafe one", async () => {
		const { catalogOnly } = await discovered();
		expect(row(catalogOnly?.models, "brand-new-host:shared-model")).toBeDefined();
		expect(catalogOnly?.models.some((m) => m.providerId === "Bad Slug!")).toBe(false);
	});

	it("doesn't duplicate a slug a real provider claims", async () => {
		const { catalogOnly } = await discovered();
		const providers = new Set(catalogOnly?.models.map((m) => m.providerId));
		for (const claimed of ["openrouter", "nvidia", "deepseek"]) expect(providers).not.toContain(claimed);
	});

	it("holds a bad publish in this file too, not only in the registry", async () => {
		const first = await discovered();
		resetModelsDevCatalogCache();
		const poisoned = structuredClone(CATALOG);
		poisoned["opencode-go"].models["kimi-k3.1-pro"].cost = { input: 200, output: 1000 };
		stubFetch(() => new Response(JSON.stringify(poisoned)));
		const { catalogOnly } = await discovered(first.home);
		const held = row(catalogOnly?.models, "opencode-go:kimi-k3.1-pro");
		expect(held?.pricing).toMatchObject({ inputPerMillion: 2, outputPerMillion: 10 });
		expect(held?.rawCapabilities).toContain("pricing_quarantined");
	});

	it("makes no network call on a cache hit", async () => {
		const first = await discovered();
		const before = readFileSync(join(first.home, "catalog-only.json"), "utf-8");
		resetModelsDevCatalogCache();
		const fetched = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", fetched);
		const registry = new ModelRegistry({ cacheDir: join(first.home, "cache") });
		await registry.discover({ includeLocal: false, enrichWithPricing: false });
		expect(fetched).not.toHaveBeenCalled();
		expect(readFileSync(join(first.home, "catalog-only.json"), "utf-8")).toBe(before);
	});

	it("leaves the previous file in place when the catalog can't be fetched", async () => {
		const home = mkdtempSync(join(tmpdir(), "kosha-catalog-only-"));
		writeFileSync(join(home, "catalog-only.json"), JSON.stringify({ schemaVersion: 1, models: [{ key: "kept:x" }] }));
		stubFetch(() => new Response("nope", { status: 503 }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { catalogOnly, manifest } = await discovered(home);
		warn.mockRestore();
		expect(catalogOnly?.models.map((m) => m.key)).toEqual(["kept:x"]);
		expect(manifest).not.toBeNull();
	});
});
