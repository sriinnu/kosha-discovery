/**
 * AnthropicDiscoverer — live Models API metadata.
 *
 * The Models API publishes `max_input_tokens`, `max_tokens`, and a nested
 * `capabilities` tree. These must land on the ModelCard and win over any
 * ID-based inference, while responses without them keep the legacy path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/discovery/public-seed.js", () => ({
	getPublicSeed: vi.fn(async () => []),
}));

import { AnthropicDiscoverer, capabilityTagsFromAnthropicApi } from "../src/discovery/anthropic.js";
import { STATIC_ANTHROPIC_MODELS } from "../src/discovery/static-direct.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

function mockModelsApi(data: unknown[]) {
	const fn = vi.fn(async () =>
		new Response(JSON.stringify({ data, has_more: false, first_id: null, last_id: null }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	globalThis.fetch = fn as unknown as typeof fetch;
	return fn;
}

const liveTree = {
	thinking: { types: { adaptive: { supported: true }, enabled: { supported: false } } },
	vision: { supported: true },
	tools: { supported: true },
	structured_outputs: { supported: true },
	prompt_caching: { supported: true },
	effort: { supported: true, levels: ["low", "medium", "high", "xhigh", "max"] },
	fast_mode: { supported: false },
};

describe("AnthropicDiscoverer", () => {
	it("uses max_input_tokens / max_tokens / capabilities from the live API", async () => {
		mockModelsApi([
			{
				id: "claude-opus-5",
				display_name: "Claude Opus 5",
				created_at: "2026-05-01T00:00:00Z",
				type: "model",
				max_input_tokens: 1_000_000,
				max_tokens: 128_000,
				capabilities: liveTree,
			},
		]);
		const cards = await new AnthropicDiscoverer().discover({ apiKey: "sk-ant-test", source: "env" });
		expect(cards).toHaveLength(1);
		const card = cards[0];
		expect(card.contextWindow).toBe(1_000_000);
		expect(card.maxOutputTokens).toBe(128_000);
		expect(card.capabilities).toEqual(
			expect.arrayContaining(["chat", "vision", "function_calling", "reasoning", "structured_output", "prompt_caching", "effort"]),
		);
		expect(card.capabilities).not.toContain("fast_mode");
		expect(card.rawCapabilities).toEqual(card.capabilities);
		expect(card.source).toBe("api");
	});

	it("keeps the ID-inference path when the API omits the new fields", async () => {
		mockModelsApi([
			{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-01-01T00:00:00Z", type: "model" },
		]);
		const [card] = await new AnthropicDiscoverer().discover({ apiKey: "sk-ant-test", source: "env" });
		expect(card.contextWindow).toBe(0); // left for enrichment
		expect(card.maxOutputTokens).toBe(0);
		expect(card.capabilities).toEqual(expect.arrayContaining(["chat", "code", "nlu", "function_calling", "vision"]));
		expect(card.capabilities).not.toContain("reasoning");
	});

	it("sends x-api-key and anthropic-version headers", async () => {
		const fn = mockModelsApi([]);
		await new AnthropicDiscoverer().discover({ apiKey: "sk-ant-test", source: "env" });
		const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
		const headers = new Headers(init.headers);
		expect(headers.get("x-api-key")).toBe("sk-ant-test");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
	});

	it("falls back to the static catalog with real limits when unauthenticated and seeds are empty", async () => {
		const cards = await new AnthropicDiscoverer().discover({ source: "none" });
		const ids = cards.map((c) => c.id);
		expect(ids).toEqual(expect.arrayContaining(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]));
		const haiku = cards.find((c) => c.id === "claude-haiku-4-5");
		expect(haiku?.contextWindow).toBe(200_000);
		expect(haiku?.maxOutputTokens).toBe(64_000);
		expect(haiku?.source).toBe("manual");
		for (const card of cards) expect(card.capabilities).toContain("structured_output");
	});
});

describe("capabilityTagsFromAnthropicApi", () => {
	it("maps supported subtrees onto kosha tags and passes unknown keys through", () => {
		expect(capabilityTagsFromAnthropicApi(liveTree).sort()).toEqual(
			["effort", "function_calling", "prompt_caching", "reasoning", "structured_output", "vision"].sort(),
		);
		expect(capabilityTagsFromAnthropicApi({ brand_new_feature: { supported: true } })).toEqual(["brand_new_feature"]);
	});

	it("accepts boolean leaves and never resolves keys through Object.prototype", () => {
		expect(capabilityTagsFromAnthropicApi({ vision: true })).toEqual(["vision"]);
		expect(capabilityTagsFromAnthropicApi({ constructor: { supported: true } })).toEqual(["constructor"]);
		for (const tag of capabilityTagsFromAnthropicApi({ constructor: { supported: true }, toString: true })) {
			expect(typeof tag).toBe("string");
		}
	});

	it("ignores features whose every variant is unsupported", () => {
		expect(capabilityTagsFromAnthropicApi({ thinking: { types: { enabled: { supported: false } } } })).toEqual([]);
		expect(capabilityTagsFromAnthropicApi(undefined)).toEqual([]);
	});
});

describe("STATIC_ANTHROPIC_MODELS", () => {
	it("uses bare (non-dated) IDs and carries limits for every entry", () => {
		for (const m of STATIC_ANTHROPIC_MODELS) {
			expect(m.id, m.id).not.toMatch(/-\d{8}$/);
			expect(m.contextWindow, m.id).toBeGreaterThan(0);
			expect(m.maxOutputTokens, m.id).toBeGreaterThan(0);
		}
	});
});
