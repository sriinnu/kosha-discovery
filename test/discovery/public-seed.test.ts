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

vi.mock("../../src/discovery/snapshot-catalog.js", () => ({
	getSnapshotSeed: vi.fn(async (provider: string) => [seed(provider, "claude-opus-5-5", { catalogSource: "snapshot" })]),
}));

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
import { getLiteLLMSeed } from "../../src/discovery/litellm-seed.js";
import { getModelsDevSeed } from "../../src/discovery/modelsdev-seed.js";
import { getSnapshotSeed } from "../../src/discovery/snapshot-catalog.js";

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

describe("getPublicSeed — when both catalogs are down", () => {
	const down = () => new Error("fetch failed");

	it("falls back to the published snapshot only when both loaders failed", async () => {
		vi.mocked(getModelsDevSeed).mockRejectedValueOnce(down());
		vi.mocked(getLiteLLMSeed).mockRejectedValueOnce(down());
		const cards = await getPublicSeed("perplexity");
		expect(cards.map((c) => c.catalogSource)).toEqual(["snapshot"]);
		// The creator is still recovered from the ID on the snapshot path.
		expect(cards[0].originProvider).toBe("anthropic");
		expect(getSnapshotSeed).toHaveBeenCalledWith("perplexity");
	});

	it("uses the snapshot when the only catalog that maps the provider is down", async () => {
		// Bedrock is mapped in models.dev alone; LiteLLM's empty answer is honest.
		vi.mocked(getModelsDevSeed).mockRejectedValueOnce(down());
		vi.mocked(getLiteLLMSeed).mockResolvedValueOnce([]);
		expect((await getPublicSeed("bedrock")).map((c) => c.catalogSource)).toEqual(["snapshot"]);
	});

	it("does not touch the snapshot when a catalog answered with something", async () => {
		vi.mocked(getSnapshotSeed).mockClear();
		vi.mocked(getModelsDevSeed).mockRejectedValueOnce(down());
		const cards = await getPublicSeed("anthropic");
		expect(cards.map((c) => c.catalogSource)).toEqual(["litellm", "litellm"]);
		expect(getSnapshotSeed).not.toHaveBeenCalled();
	});

	it("does not touch the snapshot when both catalogs loaded and have nothing", async () => {
		vi.mocked(getSnapshotSeed).mockClear();
		vi.mocked(getModelsDevSeed).mockResolvedValueOnce([]);
		vi.mocked(getLiteLLMSeed).mockResolvedValueOnce([]);
		expect(await getPublicSeed("typesafe")).toEqual([]);
		expect(getSnapshotSeed).not.toHaveBeenCalled();
	});

	it("returns nothing, not an error, when the snapshot is down too", async () => {
		vi.mocked(getModelsDevSeed).mockRejectedValueOnce(down());
		vi.mocked(getLiteLLMSeed).mockRejectedValueOnce(down());
		vi.mocked(getSnapshotSeed).mockRejectedValueOnce(down());
		expect(await getPublicSeed("anthropic")).toEqual([]);
	});
});
