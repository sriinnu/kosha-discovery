/**
 * Tests for the merged public seed: catalog priority and creator attribution.
 */

import { describe, expect, it, vi } from "vitest";
import type { ModelCard } from "../../src/types.js";

const seed = (provider: string, id: string, extra: Partial<ModelCard> = {}): ModelCard => ({
	id,
	name: id,
	provider,
	originProvider: provider,
	mode: "chat",
	capabilities: ["chat"],
	contextWindow: 0,
	maxOutputTokens: 0,
	aliases: [],
	discoveredAt: 0,
	source: "litellm",
	...extra,
});

vi.mock("../../src/discovery/modelsdev-seed.js", () => ({
	getModelsDevSeed: vi.fn(async (provider: string) => [
		seed(provider, "claude-opus-5-5", { catalogSource: "models.dev" }),
		seed(provider, "sonar-pro", { catalogSource: "models.dev" }),
		seed(provider, "nvidia/llama-3.1-nemotron-ultra-253b-v1"),
		seed(provider, "anthropic.claude-opus-5-5", { originProvider: "anthropic" }),
	]),
}));

vi.mock("../../src/discovery/litellm-seed.js", () => ({
	getLiteLLMSeed: vi.fn(async (provider: string) => [
		seed(provider, "claude-opus-5-5", { catalogSource: "litellm" }),
		seed(provider, "gpt-6-sol", { catalogSource: "litellm" }),
	]),
}));

import { getPublicSeed } from "../../src/discovery/public-seed.js";

describe("getPublicSeed", () => {
	it("attributes a reseller's rows to whoever built the model", async () => {
		const cards = await getPublicSeed("perplexity");
		const origin = (id: string) => cards.find((c) => c.id === id)?.originProvider;
		expect(origin("claude-opus-5-5")).toBe("anthropic");
		expect(origin("gpt-6-sol")).toBe("openai");
		// The provider's own models, and anything unrecognised, stay with it.
		expect(origin("sonar-pro")).toBe("perplexity");
		// Same rule the live discoverers apply: a Llama fine-tune is Meta's.
		expect(origin("nvidia/llama-3.1-nemotron-ultra-253b-v1")).toBe("meta");
	});

	it("leaves a provider's own flagship as a direct route", async () => {
		const cards = await getPublicSeed("anthropic");
		expect(cards.find((c) => c.id === "claude-opus-5-5")?.originProvider).toBe("anthropic");
	});

	it("does not overwrite an origin a seed already resolved", async () => {
		const cards = await getPublicSeed("bedrock");
		expect(cards.find((c) => c.id === "anthropic.claude-opus-5-5")?.originProvider).toBe("anthropic");
	});

	it("keeps models.dev ahead of LiteLLM for the same ID", async () => {
		const cards = await getPublicSeed("perplexity");
		expect(cards.filter((c) => c.id === "claude-opus-5-5")).toHaveLength(1);
		expect(cards.find((c) => c.id === "claude-opus-5-5")?.catalogSource).toBe("models.dev");
	});
});
