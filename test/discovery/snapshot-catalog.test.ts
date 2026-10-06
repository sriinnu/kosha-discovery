/**
 * Tests for the snapshot catalog: kosha's own published snapshot as the
 * last-resort keyless seed when models.dev and LiteLLM are both unreachable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getSnapshotSeed,
	loadSnapshotCatalog,
	resetSnapshotCatalogCache,
	SNAPSHOT_CATALOG_URL,
	SNAPSHOT_CATALOG_URL_ENV,
	snapshotCatalogUrl,
} from "../../src/discovery/snapshot-catalog.js";

const card = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: id,
	provider,
	originProvider: provider,
	mode: "chat",
	capabilities: ["chat"],
	contextWindow: 1_000_000,
	maxOutputTokens: 128_000,
	pricing: { inputPerMillion: 4, outputPerMillion: 20 },
	aliases: [],
	discoveredAt: 1,
	source: "litellm",
	catalogSource: "models.dev",
	...extra,
});

const SNAPSHOT = {
	fetchedAt: "2026-10-05T06:37:44.378Z",
	providerCount: 3,
	modelCount: 4,
	providers: [
		{ id: "anthropic", models: [card("anthropic", "claude-opus-5-5"), card("anthropic", "claude-sonnet-5-5")] },
		// A row filed under the wrong provider, and one missing required fields.
		{ id: "openai", models: [card("openai", "gpt-6-sol"), card("anthropic", "stray"), { id: "half-a-card" }] },
		{ id: "ollama", models: [] },
	],
};

function mockFetch(body: unknown, init: ResponseInit = { status: 200 }) {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), init));
}

beforeEach(() => resetSnapshotCatalogCache());
afterEach(() => {
	vi.restoreAllMocks();
	delete process.env[SNAPSHOT_CATALOG_URL_ENV];
});

describe("snapshot catalog", () => {
	it("fetches the snapshot-latest asset once and serves providers from it", async () => {
		const fetchSpy = mockFetch(SNAPSHOT);
		const anthropic = await getSnapshotSeed("anthropic");
		const openai = await getSnapshotSeed("openai");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toBe(SNAPSHOT_CATALOG_URL);
		expect(anthropic.map((c) => c.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
		// The stray row and the half card are dropped; the real one survives.
		expect(openai.map((c) => c.id)).toEqual(["gpt-6-sol"]);
	});

	it("stamps provenance and a fresh discovery time, keeping the price", async () => {
		mockFetch(SNAPSHOT);
		const [opus] = await getSnapshotSeed("anthropic");
		expect(opus.catalogSource).toBe("snapshot");
		expect(opus.source).toBe("litellm");
		expect(opus.discoveredAt).toBeGreaterThan(1);
		expect(opus.pricing).toEqual({ inputPerMillion: 4, outputPerMillion: 20 });
	});

	it("returns nothing for a provider the snapshot does not carry", async () => {
		mockFetch(SNAPSHOT);
		expect(await getSnapshotSeed("ollama")).toEqual([]);
		expect(await getSnapshotSeed("nope")).toEqual([]);
	});

	it("rejects a payload that is not a snapshot, and retries on the next call", async () => {
		const fetchSpy = mockFetch({ not: "a snapshot" });
		await expect(loadSnapshotCatalog()).rejects.toThrow(/providers array/);
		fetchSpy.mockResolvedValue(new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
		expect((await getSnapshotSeed("anthropic")).length).toBe(2);
	});

	it("rejects an HTTP error", async () => {
		mockFetch("", { status: 404, statusText: "Not Found" });
		await expect(loadSnapshotCatalog()).rejects.toThrow(/404/);
	});

	it("honours an https env override and ignores anything else", () => {
		process.env[SNAPSHOT_CATALOG_URL_ENV] = "https://mirror.example/kosha-latest.json";
		expect(snapshotCatalogUrl()).toBe("https://mirror.example/kosha-latest.json");
		process.env[SNAPSHOT_CATALOG_URL_ENV] = "http://mirror.example/kosha-latest.json";
		expect(snapshotCatalogUrl()).toBe(SNAPSHOT_CATALOG_URL);
		process.env[SNAPSHOT_CATALOG_URL_ENV] = "file:///etc/passwd";
		expect(snapshotCatalogUrl()).toBe(SNAPSHOT_CATALOG_URL);
	});
});
