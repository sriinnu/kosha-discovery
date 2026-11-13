/**
 * The price anchor: a move is checked against the highest price accepted in
 * the last 30 days, not only the last one, so a price can't walk down in
 * steps just under the quarantine threshold. A move back up toward the anchor
 * is a correction and is taken at once.
 */
import { describe, expect, it } from "vitest";
import type { DiscoveryModelV1, DiscoverySnapshotV1 } from "../src/discovery-contract.js";
import { DISCOVERY_SCHEMA_VERSION } from "../src/discovery-contract.js";
import { mergeManifests } from "../src/registry-runtime.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function snap(input: number, discoveredAt: number): DiscoverySnapshotV1 {
	const model = {
		key: "openai:m",
		modelId: "m",
		name: "m",
		providerId: "openai",
		canonicalProviderId: "openai",
		originProviderId: "openai",
		mode: "chat",
		capabilities: [],
		rawCapabilities: [],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		pricing: { inputPerMillion: input, outputPerMillion: input * 3 },
		dimensions: null,
		maxInputTokens: null,
		discoveredAt,
		source: "api",
	} as DiscoveryModelV1;
	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		discoveredAt,
		cursor: "",
		providers: [],
		models: [model],
		roles: [],
		health: [],
		credentialPrompts: [],
	};
}

/** Run a sequence of published input prices through the merge, one an hour. */
function publish(prices: number[], start: DiscoverySnapshotV1 | null = null, from = 0) {
	let manifest = start;
	const accepted: number[] = [];
	prices.forEach((price, i) => {
		manifest = mergeManifests(manifest, snap(price, from + i * HOUR));
		accepted.push(manifest.models[0].pricing?.inputPerMillion ?? Number.NaN);
	});
	return { manifest: manifest as unknown as DiscoverySnapshotV1, accepted };
}

describe("the anchor stops a price walking down", () => {
	it("holds a cut just under the step threshold", () => {
		const { accepted } = publish([10, 2.6]);
		expect(accepted).toEqual([10, 10]);
	});

	it("lets 15% steps through until the total passes half, then holds", () => {
		const { accepted } = publish([10, 8.5, 7.2, 6.1, 5.2, 4.4]);
		expect(accepted).toEqual([10, 8.5, 7.2, 6.1, 5.2, 5.2]);
	});

	it("takes one real 50% cut at once", () => {
		expect(publish([10, 5]).accepted).toEqual([10, 5]);
	});

	it("still releases a held drift once its window passes", () => {
		const { manifest } = publish([10, 2.6]);
		const later = mergeManifests(manifest, snap(2.6, 3 * DAY + 2 * HOUR));
		expect(later.models[0].pricing?.inputPerMillion).toBe(2.6);
		// Released means released: the same price on the next run isn't re-held.
		const next = mergeManifests(later, snap(2.6, 3 * DAY + 3 * HOUR));
		expect(next.models[0].rawCapabilities).not.toContain("pricing_quarantined");
	});

	it("lets the current price become the anchor after 30 days", () => {
		const { manifest } = publish([10, 5]);
		const steady = mergeManifests(manifest, snap(5, 31 * DAY));
		const cut = mergeManifests(steady, snap(2.5, 31 * DAY + HOUR));
		expect(cut.models[0].pricing?.inputPerMillion).toBe(2.5);
	});
});

describe("a correction toward the anchor", () => {
	it("is taken at once, even past the step threshold", () => {
		// 10 → 5.5 passes (within half); 5.5 → 10 is an 82% step, but back to
		// where the price stood, so the wrong low price isn't protected.
		expect(publish([10, 5.5, 10]).accepted).toEqual([10, 5.5, 10]);
	});

	it("doesn't cover a rise past the anchor", () => {
		expect(publish([10, 5.5, 12]).accepted).toEqual([10, 5.5, 5.5]);
	});
});

describe("existing manifests", () => {
	it("seed an anchor from the accepted price on the first merge", () => {
		const legacy = snap(10, 0); // a row written before anchors existed
		const merged = mergeManifests(legacy, snap(10, HOUR));
		expect((merged.models[0] as { priceAnchor?: { inputPerMillion?: number } }).priceAnchor?.inputPerMillion).toBe(10);
	});
});
