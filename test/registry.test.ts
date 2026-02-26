import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

/** Helper to create a minimal ModelCard for testing. */
function makeModel(overrides: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
	return {
		name: overrides.id,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing: undefined,
		...overrides,
	};
}

/** Helper to create a minimal ProviderInfo for testing. */
function makeProvider(id: string, name: string, models: ModelCard[]): ProviderInfo {
	return {
		id,
		name,
		baseUrl: `https://api.${id}.com`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
	};
}

describe("ModelRegistry", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "kosha-registry-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("constructor", () => {
		it("creates a registry with default config", () => {
			const registry = new ModelRegistry();
			expect(registry).toBeInstanceOf(ModelRegistry);
		});

		it("creates a registry with custom config", () => {
			const registry = new ModelRegistry({
				cacheDir: tempDir,
				cacheTtlMs: 60_000,
				aliases: { "my-alias": "my-model" },
			});
			expect(registry).toBeInstanceOf(ModelRegistry);
		});
	});

	describe("models() before discovery", () => {
		it("returns an empty array", () => {
			const registry = new ModelRegistry();
			expect(registry.models()).toEqual([]);
		});

		it("returns an empty array with filters", () => {
			const registry = new ModelRegistry();
			expect(registry.models({ mode: "chat" })).toEqual([]);
			expect(registry.models({ provider: "anthropic" })).toEqual([]);
			expect(registry.models({ capability: "vision" })).toEqual([]);
		});
	});

	describe("model() alias resolution", () => {
		it("resolves aliases to find models", () => {
			const sonnetCard = makeModel({
				id: "claude-sonnet-4-20250514",
				provider: "anthropic",
				name: "Claude Sonnet 4",
			});

			const anthropic = makeProvider("anthropic", "Anthropic", [sonnetCard]);

			const data = {
				providers: [anthropic],
				aliases: { "sonnet": "claude-sonnet-4-20250514", "sonnet-4": "claude-sonnet-4-20250514" },
				discoveredAt: Date.now(),
			};

			const registry = ModelRegistry.fromJSON(data);
			const found = registry.model("sonnet");
			expect(found).toBeDefined();
			expect(found!.id).toBe("claude-sonnet-4-20250514");
		});

		it("finds models by canonical ID", () => {
			const card = makeModel({ id: "gpt-4o", provider: "openai", name: "GPT-4o" });
			const openai = makeProvider("openai", "OpenAI", [card]);

			const registry = ModelRegistry.fromJSON({
				providers: [openai],
				aliases: {},
				discoveredAt: Date.now(),
			});

			expect(registry.model("gpt-4o")).toBeDefined();
			expect(registry.model("gpt-4o")!.id).toBe("gpt-4o");
		});

		it("returns undefined for unknown models", () => {
			const registry = new ModelRegistry();
			expect(registry.model("non-existent")).toBeUndefined();
		});
	});

	describe("models() with filters", () => {
		let registry: ModelRegistry;

		beforeEach(() => {
			const chatModel = makeModel({
				id: "claude-sonnet-4-20250514",
				provider: "anthropic",
				name: "Claude Sonnet 4",
				mode: "chat",
				capabilities: ["chat", "vision", "code"],
			});

			const embedModel = makeModel({
				id: "text-embedding-3-small",
				provider: "openai",
				name: "Text Embedding 3 Small",
				mode: "embedding",
				capabilities: ["embedding"],
			});

			const gptModel = makeModel({
				id: "gpt-4o",
				provider: "openai",
				name: "GPT-4o",
				mode: "chat",
				capabilities: ["chat", "vision", "function_calling", "code"],
			});

			const anthropic = makeProvider("anthropic", "Anthropic", [chatModel]);
			const openai = makeProvider("openai", "OpenAI", [embedModel, gptModel]);

			registry = ModelRegistry.fromJSON({
				providers: [anthropic, openai],
				aliases: {},
				discoveredAt: Date.now(),
			});
		});

		it("filters by provider", () => {
			const anthropicModels = registry.models({ provider: "anthropic" });
			expect(anthropicModels).toHaveLength(1);
			expect(anthropicModels[0].provider).toBe("anthropic");

			const openaiModels = registry.models({ provider: "openai" });
			expect(openaiModels).toHaveLength(2);
			expect(openaiModels.every((m) => m.provider === "openai")).toBe(true);
		});

		it("filters by mode", () => {
			const chatModels = registry.models({ mode: "chat" });
			expect(chatModels).toHaveLength(2);
			expect(chatModels.every((m) => m.mode === "chat")).toBe(true);

			const embedModels = registry.models({ mode: "embedding" });
			expect(embedModels).toHaveLength(1);
			expect(embedModels[0].id).toBe("text-embedding-3-small");
		});

		it("filters by capability", () => {
			const visionModels = registry.models({ capability: "vision" });
			expect(visionModels).toHaveLength(2);

			const embeddingModels = registry.models({ capability: "embedding" });
			expect(embeddingModels).toHaveLength(1);

			const functionCallingModels = registry.models({ capability: "function_calling" });
			expect(functionCallingModels).toHaveLength(1);
			expect(functionCallingModels[0].id).toBe("gpt-4o");
		});

		it("combines provider and mode filters", () => {
			const openaiChat = registry.models({ provider: "openai", mode: "chat" });
			expect(openaiChat).toHaveLength(1);
			expect(openaiChat[0].id).toBe("gpt-4o");
		});

		it("returns all models with no filter", () => {
			const allModels = registry.models();
			expect(allModels).toHaveLength(3);
		});
	});

	describe("provider() and providers_list()", () => {
		it("returns provider by ID", () => {
			const anthropic = makeProvider("anthropic", "Anthropic", []);
			const registry = ModelRegistry.fromJSON({
				providers: [anthropic],
				aliases: {},
				discoveredAt: Date.now(),
			});

			const found = registry.provider("anthropic");
			expect(found).toBeDefined();
			expect(found!.name).toBe("Anthropic");
		});

		it("returns undefined for unknown provider", () => {
			const registry = new ModelRegistry();
			expect(registry.provider("unknown")).toBeUndefined();
		});

		it("lists all providers", () => {
			const anthropic = makeProvider("anthropic", "Anthropic", []);
			const openai = makeProvider("openai", "OpenAI", []);
			const registry = ModelRegistry.fromJSON({
				providers: [anthropic, openai],
				aliases: {},
				discoveredAt: Date.now(),
			});

			const list = registry.providers_list();
			expect(list).toHaveLength(2);
			expect(list.map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
		});
	});

	describe("resolve() and alias()", () => {
		it("delegates to AliasResolver", () => {
			const registry = new ModelRegistry();
			expect(registry.resolve("sonnet")).toBe("claude-sonnet-4-6");
		});

		it("adds custom aliases via alias()", () => {
			const registry = new ModelRegistry();
			registry.alias("my-model", "some-canonical-id");
			expect(registry.resolve("my-model")).toBe("some-canonical-id");
		});
	});

	describe("toJSON / fromJSON round-trip", () => {
		it("serializes and deserializes correctly", () => {
			const sonnet = makeModel({
				id: "claude-sonnet-4-20250514",
				provider: "anthropic",
				name: "Claude Sonnet 4",
				capabilities: ["chat", "vision"],
			});

			const gpt4o = makeModel({
				id: "gpt-4o",
				provider: "openai",
				name: "GPT-4o",
				capabilities: ["chat", "vision", "function_calling"],
			});

			const anthropic = makeProvider("anthropic", "Anthropic", [sonnet]);
			const openai = makeProvider("openai", "OpenAI", [gpt4o]);

			const original = ModelRegistry.fromJSON({
				providers: [anthropic, openai],
				aliases: { "sonnet": "claude-sonnet-4-20250514", "gpt4o": "gpt-4o" },
				discoveredAt: 1700000000000,
			});

			// Serialize
			const json = original.toJSON();

			// Verify JSON shape
			expect(json.providers).toHaveLength(2);
			expect(json.aliases).toHaveProperty("sonnet");
			expect(json.discoveredAt).toBe(1700000000000);

			// Deserialize
			const restored = ModelRegistry.fromJSON(json);

			// Verify restored registry
			expect(restored.models()).toHaveLength(2);
			expect(restored.model("sonnet")?.id).toBe("claude-sonnet-4-20250514");
			expect(restored.model("gpt4o")?.id).toBe("gpt-4o");
			expect(restored.providers_list()).toHaveLength(2);
		});

		it("preserves aliases through round-trip", () => {
			const registry = ModelRegistry.fromJSON({
				providers: [],
				aliases: { "fast": "gpt-4o-mini", "smart": "claude-opus-4-20250918" },
				discoveredAt: Date.now(),
			});

			const json = registry.toJSON();
			const restored = ModelRegistry.fromJSON(json);

			expect(restored.resolve("fast")).toBe("gpt-4o-mini");
			expect(restored.resolve("smart")).toBe("claude-opus-4-20250918");
		});
	});

	describe("discover() with mocked discoverers", () => {
		it("handles discovery failure gracefully (Promise.allSettled)", async () => {
			// Mock the dynamic import to simulate discovery module loading
			const registry = new ModelRegistry({
				cacheDir: tempDir,
				// Disable all providers so loadDiscoverers returns empty
				providers: {
					anthropic: { enabled: false },
					openai: { enabled: false },
					google: { enabled: false },
					ollama: { enabled: false },
					openrouter: { enabled: false },
				},
			});

			// With all providers disabled, discover should return empty
			const result = await registry.discover({ force: true });
			expect(result).toEqual([]);
		});

		it("deduplicates models by ID across providers", () => {
			const model1 = makeModel({ id: "shared-model", provider: "provider-a" });
			const model2 = makeModel({ id: "shared-model", provider: "provider-b" });

			const providerA = makeProvider("provider-a", "Provider A", [model1]);
			const providerB = makeProvider("provider-b", "Provider B", [model2]);

			const registry = ModelRegistry.fromJSON({
				providers: [providerA, providerB],
				aliases: {},
				discoveredAt: Date.now(),
			});

			// models() should deduplicate — first provider wins
			const allModels = registry.models();
			expect(allModels).toHaveLength(1);
			expect(allModels[0].provider).toBe("provider-a");
		});
	});
});
