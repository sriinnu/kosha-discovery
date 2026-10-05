import { describe, expect, it } from "vitest";
import { applyPromoOverrides as applyWith, PROMO_OVERRIDES, type PromoOverride } from "../../src/discovery/promo-overrides.js";
import type { ModelCard } from "../../src/types.js";

// The built-in table is allowed to be empty, so behaviour is exercised against
// a fixture rather than whichever promo happens to be live.
const FIXTURE: readonly PromoOverride[] = [
	{
		providerId: "deepseek",
		modelId: "deepseek-v4-pro",
		pricing: { inputPerMillion: 0.435, outputPerMillion: 0.87, cacheReadPerMillion: 0.003625 },
		endsAt: new Date("2026-05-31T15:59:00Z"),
		reason: "test fixture",
	},
];

const applyPromoOverrides = (cards: ModelCard[], now?: Date): ModelCard[] => applyWith(cards, now, FIXTURE);

function card(provider: string, id: string, pricing: ModelCard["pricing"]): ModelCard {
	return {
		id,
		name: id,
		provider,
		originProvider: provider,
		mode: "chat",
		capabilities: ["chat"],
		rawCapabilities: ["chat"],
		contextWindow: 0,
		maxOutputTokens: 0,
		pricing,
		aliases: [],
		discoveredAt: 0,
		source: "litellm",
	};
}

describe("applyPromoOverrides", () => {
	it("rewrites pricing on a matching active promo", () => {
		const cards = [card("deepseek", "deepseek-v4-pro", { inputPerMillion: 1.74, outputPerMillion: 3.48 })];
		const before = new Date("2026-04-26T00:00:00Z"); // before May 5, 2026 expiry
		applyPromoOverrides(cards, before);
		expect(cards[0].pricing?.inputPerMillion).toBeCloseTo(0.435);
		expect(cards[0].pricing?.outputPerMillion).toBeCloseTo(0.87);
		expect(cards[0].pricing?.cacheReadPerMillion).toBeCloseTo(0.003625);
		expect(cards[0].rawCapabilities).toContain("promo_override");
	});

	it("leaves pricing alone when the promo has expired", () => {
		const cards = [card("deepseek", "deepseek-v4-pro", { inputPerMillion: 1.74, outputPerMillion: 3.48 })];
		const after = new Date("2027-01-01T00:00:00Z"); // well past expiry
		applyPromoOverrides(cards, after);
		expect(cards[0].pricing?.inputPerMillion).toBe(1.74);
		expect(cards[0].pricing?.outputPerMillion).toBe(3.48);
		expect(cards[0].rawCapabilities).not.toContain("promo_override");
	});

	it("does not touch cards that don't match any override", () => {
		const cards = [card("openai", "gpt-5.5", { inputPerMillion: 5, outputPerMillion: 30 })];
		applyPromoOverrides(cards, new Date("2026-04-26T00:00:00Z"));
		expect(cards[0].pricing?.inputPerMillion).toBe(5);
		expect(cards[0].rawCapabilities).not.toContain("promo_override");
	});

	it("is a no-op on an empty card list", () => {
		const cards: ModelCard[] = [];
		const result = applyPromoOverrides(cards);
		expect(result).toBe(cards);
		expect(result).toHaveLength(0);
	});

	it("never matches by partial id (exact match only)", () => {
		const cards = [card("deepseek", "deepseek-v4-pro-foo", { inputPerMillion: 1, outputPerMillion: 2 })];
		applyPromoOverrides(cards, new Date("2026-04-26T00:00:00Z"));
		expect(cards[0].pricing?.inputPerMillion).toBe(1);
	});

	it("never matches across providers", () => {
		const cards = [card("openrouter", "deepseek-v4-pro", { inputPerMillion: 1, outputPerMillion: 2 })];
		applyPromoOverrides(cards, new Date("2026-04-26T00:00:00Z"));
		expect(cards[0].pricing?.inputPerMillion).toBe(1);
	});

	it("every built-in entry has a future-or-recently-past expiry (sanity check)", () => {
		// Keep this list small. If an entry has been expired for >180 days, delete
		// it from the source rather than letting it rot.
		const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
		for (const promo of PROMO_OVERRIDES) {
			expect(promo.endsAt.getTime()).toBeGreaterThan(cutoff);
		}
	});
});
