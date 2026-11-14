/** A model past its sunset day is retired, whatever its status still says. */
import { describe, expect, it } from "vitest";
import { isRetired } from "../src/lifecycle.js";
import { ModelRegistry } from "../src/registry.js";
import { rankCandidatesByStrategy } from "../src/registry-routing.js";
import { createRegistryState } from "../src/registry-state.js";
import type { ModelCard } from "../src/types.js";

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

function card(id: string, input: number, extra: Partial<ModelCard> = {}): ModelCard {
	return {
		id,
		name: id,
		provider: "openai",
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing: { inputPerMillion: input, outputPerMillion: input * 4 },
		...extra,
	};
}

describe("isRetired", () => {
	it("follows the status and the sunset day", () => {
		expect(isRetired({ status: "retired" })).toBe(true);
		expect(isRetired({ status: "deprecated", deprecationDate: iso(-1) })).toBe(true);
		expect(isRetired({ status: "deprecated", deprecationDate: iso(30) })).toBe(false);
		expect(isRetired({ status: "active" })).toBe(false);
		expect(isRetired({ status: "deprecated", deprecationDate: "not a date" })).toBe(false);
	});
});

describe("a model past its sunset", () => {
	const sunset = card("old", 0.1, { status: "deprecated", deprecationDate: iso(-31) });
	const live = card("new", 1);

	it("is not offered by cheapest", () => {
		const registry = ModelRegistry.fromJSON({
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					baseUrl: "https://api.openai.com/v1",
					authenticated: true,
					models: [sunset, live],
					lastRefreshed: Date.now(),
				},
			],
			aliases: {},
			discoveredAt: Date.now(),
		} as never);
		expect(registry.cheapestModels({ mode: "chat", limit: 5 }).matches.map((m) => m.model.id)).toEqual(["new"]);
	});

	it("is dropped from route ranking", () => {
		const ranked = rankCandidatesByStrategy(
			createRegistryState(),
			[
				{ model: sunset, score: 0.1, priceMetric: "blended" },
				{ model: live, score: 1, priceMetric: "blended" },
			],
			"cheapest",
		);
		expect(ranked.map((r) => r.model.id)).toEqual(["new"]);
	});
});

describe("the preferred route", () => {
	const provider = (id: string, models: ModelCard[]) => ({
		id,
		name: id,
		baseUrl: "",
		authenticated: true,
		models,
		lastRefreshed: Date.now(),
	});
	const routesFor = (...providers: ReturnType<typeof provider>[]) =>
		ModelRegistry.fromJSON({ providers, aliases: {}, discoveredAt: Date.now() } as never).modelRouteInfo("claude-x");
	const reseller = (id: string, input: number, extra: Partial<ModelCard> = {}) =>
		card("claude-x", input, { provider: id, originProvider: "anthropic", ...extra });

	it("is never a route past its sunset, even the cheapest", () => {
		const routes = routesFor(
			provider("bedrock", [reseller("bedrock", 1, { status: "deprecated", deprecationDate: iso(-31) })]),
			provider("vertex", [reseller("vertex", 3)]),
		);
		expect(routes).toHaveLength(2);
		expect(routes.filter((r) => r.isPreferred).map((r) => r.provider)).toEqual(["vertex"]);
	});

	it("is none when every route is past its sunset", () => {
		const routes = routesFor(
			provider("bedrock", [reseller("bedrock", 1, { status: "deprecated", deprecationDate: iso(-31) })]),
		);
		expect(routes).toHaveLength(1);
		expect(routes.some((r) => r.isPreferred)).toBe(false);
	});
});
