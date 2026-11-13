/**
 * The weekly snapshot's price gate: the published snapshot goes through the
 * same quarantine as a local manifest, judged against the one before it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogEnvelope } from "../src/catalog-source.js";
import { getSnapshotSeed, resetSnapshotCatalogCache } from "../src/discovery/snapshot-catalog.js";
import { gateSnapshot } from "../src/snapshot-gate.js";
import { forgetTestKey, snapshotResponse, trustTestKey } from "./helpers/signed-snapshot.js";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

function card(id: string, input: number, extra: Record<string, unknown> = {}) {
	return {
		id,
		name: id,
		provider: "openai",
		mode: "chat",
		capabilities: [],
		rawCapabilities: [],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		pricing: { inputPerMillion: input, outputPerMillion: input * 4 },
		aliases: [],
		discoveredAt: 0,
		source: "litellm",
		...extra,
	};
}

function envelope(discoveredAt: number, cards: ReturnType<typeof card>[]): CatalogEnvelope {
	return {
		schemaVersion: 1,
		kind: "kosha-catalog",
		fetchedAt: new Date(discoveredAt).toISOString(),
		providerScope: "all",
		modelCount: cards.length,
		providerCount: 1,
		discoveredAt,
		providers: [{ id: "openai", name: "OpenAI", baseUrl: "", authenticated: false, models: cards, lastRefreshed: 0 }],
	} as unknown as CatalogEnvelope;
}

const input = (env: CatalogEnvelope, id: string) =>
	env.providers[0].models.find((m) => m.id === id)?.pricing?.inputPerMillion;

describe("gateSnapshot", () => {
	it("takes every price on the first snapshot and seeds anchors", () => {
		const { envelope: out, held } = gateSnapshot(null, envelope(0, [card("a", 10)]));
		expect(held).toEqual([]);
		expect(input(out, "a")).toBe(10);
		expect((out.providers[0].models[0] as { priceAnchor?: unknown }).priceAnchor).toBeDefined();
	});

	it("publishes a suspect cut at the previous price and lists it", () => {
		const week1 = gateSnapshot(null, envelope(0, [card("a", 10), card("b", 5)])).envelope;
		const { envelope: out, held } = gateSnapshot(week1, envelope(WEEK, [card("a", 2), card("b", 5)]));
		expect(input(out, "a")).toBe(10);
		expect(out.providers[0].models.find((m) => m.id === "a")?.rawCapabilities).toContain("pricing_quarantined");
		expect(held).toEqual([
			expect.objectContaining({
				providerId: "openai",
				modelId: "a",
				published: { inputPerMillion: 10, outputPerMillion: 40 },
				reported: { inputPerMillion: 2, outputPerMillion: 8 },
				since: WEEK,
			}),
		]);
		expect(input(out, "b")).toBe(5);
	});

	it("publishes a held rise at the higher price at once", () => {
		// 2 → 10 is past the step threshold and held, but the old, lower price
		// would undercount spend; only cuts wait.
		const week1 = gateSnapshot(null, envelope(0, [card("a", 2)])).envelope;
		const { envelope: out, held } = gateSnapshot(week1, envelope(WEEK, [card("a", 10)]));
		expect(input(out, "a")).toBe(10);
		expect(held).toEqual([]);
	});

	it("publishes a disputed row at the highest source's price", () => {
		const week1 = gateSnapshot(null, envelope(0, [card("a", 10)])).envelope;
		const evidence = [
			{ source: "models.dev", inputPerMillion: 11, outputPerMillion: 44 },
			{ source: "litellm", inputPerMillion: 14, outputPerMillion: 44 },
		];
		const { envelope: out } = gateSnapshot(week1, envelope(WEEK, [card("a", 11, { priceEvidence: evidence })]));
		const row = out.providers[0].models[0];
		expect(row.rawCapabilities).toContain("pricing_sources_disagree");
		expect(row.pricing?.inputPerMillion).toBe(14);
	});

	it("keeps a provider the fresh run returned with no models", () => {
		const empty = envelope(WEEK, [card("a", 10)]);
		empty.providers.push({
			id: "ollama",
			name: "Ollama",
			baseUrl: "",
			authenticated: false,
			models: [],
			lastRefreshed: 0,
		});
		const week1 = gateSnapshot(null, envelope(0, [card("a", 10)])).envelope;
		const { envelope: out } = gateSnapshot(week1, empty);
		expect(out.providers.map((p) => p.id)).toEqual(["openai", "ollama"]);
		expect(out.providerCount).toBe(2);
	});

	it("releases the held price a week later when it's still reported", () => {
		const week1 = gateSnapshot(null, envelope(0, [card("a", 10)])).envelope;
		const week2 = gateSnapshot(week1, envelope(WEEK, [card("a", 2)])).envelope;
		const { envelope: out, held } = gateSnapshot(week2, envelope(2 * WEEK, [card("a", 2)]));
		expect(held).toEqual([]);
		expect(input(out, "a")).toBe(2);
	});

	it("never releases a collapse to $0 by waiting, only by accept", () => {
		const week1 = gateSnapshot(null, envelope(0, [card("a", 10)])).envelope;
		const week2 = gateSnapshot(week1, envelope(WEEK, [card("a", 0)])).envelope;
		const week3 = gateSnapshot(week2, envelope(2 * WEEK, [card("a", 0)]));
		expect(input(week3.envelope, "a")).toBe(10);
		expect(week3.held).toHaveLength(1);
		const accepted = gateSnapshot(week3.envelope, envelope(3 * WEEK, [card("a", 0)]), ["openai/a"]);
		expect(input(accepted.envelope, "a")).toBe(0);
		expect(accepted.held).toEqual([]);
	});

	it("ignores an accept for a different model", () => {
		const week1 = gateSnapshot(null, envelope(0, [card("a", 10)])).envelope;
		const week2 = gateSnapshot(week1, envelope(WEEK, [card("a", 0)])).envelope;
		const out = gateSnapshot(week2, envelope(2 * WEEK, [card("a", 0)]), ["openai/b", "bogus"]);
		expect(input(out.envelope, "a")).toBe(10);
	});

	it("carries a model a thin run dropped, with counts that match", () => {
		const week1 = gateSnapshot(null, envelope(0, [card("a", 10), card("b", 5)])).envelope;
		const { envelope: out } = gateSnapshot(week1, envelope(WEEK, [card("a", 10)]));
		expect(out.providers[0].models.map((m) => m.id).sort()).toEqual(["a", "b"]);
		expect(out.modelCount).toBe(2);
		expect(out.providerCount).toBe(1);
		// No merge keys leak into the published cards.
		expect(out.providers[0].models[0]).not.toHaveProperty("key");
		expect(out.providers[0].models[0]).not.toHaveProperty("providerId");
	});
});

describe("reading a gated snapshot", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		forgetTestKey();
		resetSnapshotCatalogCache();
	});

	it("drops the publisher's hold bookkeeping from seeded cards", async () => {
		const gated = card("a", 10, {
			pricingHold: { rates: "x", since: 0, accepted: true },
			priceAnchor: { inputPerMillion: 10, at: 0 },
			lastSeenAt: 0,
			missingRunCount: 2,
		});
		trustTestKey();
		const text = JSON.stringify(envelope(0, [gated]));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => snapshotResponse(url, text)),
		);
		const [seeded] = await getSnapshotSeed("openai");
		expect(seeded.pricing?.inputPerMillion).toBe(10);
		for (const field of ["pricingHold", "priceAnchor", "lastSeenAt", "missingRunCount"]) {
			expect(seeded).not.toHaveProperty(field);
		}
	});
});
