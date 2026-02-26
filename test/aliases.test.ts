import { describe, expect, it } from "vitest";
import { AliasResolver, DEFAULT_ALIASES } from "../src/aliases.js";

describe("AliasResolver", () => {
	describe("default alias resolution", () => {
		const resolver = new AliasResolver();

		it("resolves Anthropic aliases", () => {
			expect(resolver.resolve("sonnet")).toBe("claude-sonnet-4-6");
			expect(resolver.resolve("sonnet-4")).toBe("claude-sonnet-4-6");
			expect(resolver.resolve("opus")).toBe("claude-opus-4-6");
			expect(resolver.resolve("opus-4")).toBe("claude-opus-4-6");
			expect(resolver.resolve("haiku")).toBe("claude-haiku-4-5-20251001");
			expect(resolver.resolve("haiku-4.5")).toBe("claude-haiku-4-5-20251001");
		});

		it("resolves OpenAI aliases", () => {
			expect(resolver.resolve("gpt4o")).toBe("gpt-4o");
			expect(resolver.resolve("gpt4o-mini")).toBe("gpt-4o-mini");
			expect(resolver.resolve("o3")).toBe("o3");
			expect(resolver.resolve("o3-mini")).toBe("o3-mini");
			expect(resolver.resolve("o4-mini")).toBe("o4-mini");
		});

		it("resolves Google aliases", () => {
			expect(resolver.resolve("gemini-pro")).toBe("gemini-2.5-pro-preview-05-06");
			expect(resolver.resolve("gemini-flash")).toBe("gemini-2.5-flash-preview-04-17");
			expect(resolver.resolve("gemini-flash-lite")).toBe("gemini-2.0-flash-lite");
		});

		it("resolves local model aliases", () => {
			expect(resolver.resolve("qwen")).toBe("qwen3:8b");
			expect(resolver.resolve("llama")).toBe("llama3.3:latest");
			expect(resolver.resolve("codestral")).toBe("codestral:latest");
			expect(resolver.resolve("deepseek")).toBe("deepseek-r1:latest");
		});

		it("resolves embedding aliases", () => {
			expect(resolver.resolve("embed-small")).toBe("text-embedding-3-small");
			expect(resolver.resolve("embed-large")).toBe("text-embedding-3-large");
			expect(resolver.resolve("nomic")).toBe("nomic-embed-text");
		});
	});

	describe("resolve with unknown input", () => {
		const resolver = new AliasResolver();

		it("returns the input unchanged when no alias matches", () => {
			expect(resolver.resolve("unknown-model-id")).toBe("unknown-model-id");
		});

		it("returns canonical IDs unchanged", () => {
			expect(resolver.resolve("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
		});
	});

	describe("custom alias overrides", () => {
		it("custom aliases take precedence over defaults", () => {
			const resolver = new AliasResolver({
				"sonnet": "my-custom-sonnet",
			});
			expect(resolver.resolve("sonnet")).toBe("my-custom-sonnet");
		});

		it("custom aliases coexist with defaults", () => {
			const resolver = new AliasResolver({
				"my-alias": "my-model-id",
			});
			expect(resolver.resolve("my-alias")).toBe("my-model-id");
			// Default still works
			expect(resolver.resolve("opus")).toBe("claude-opus-4-6");
		});
	});

	describe("reverseAliases", () => {
		const resolver = new AliasResolver();

		it("finds all aliases for a given model ID", () => {
			const aliases = resolver.reverseAliases("claude-sonnet-4-6");
			expect(aliases).toContain("sonnet");
			expect(aliases).toContain("sonnet-4");
			expect(aliases).toHaveLength(2);
		});

		it("returns empty array for model with no aliases", () => {
			const aliases = resolver.reverseAliases("some-model-with-no-aliases");
			expect(aliases).toEqual([]);
		});

		it("finds aliases for models with many aliases", () => {
			const aliases = resolver.reverseAliases("claude-opus-4-6");
			expect(aliases).toContain("opus");
			expect(aliases).toContain("opus-4");
		});
	});

	describe("addAlias", () => {
		it("adds a new alias", () => {
			const resolver = new AliasResolver();
			resolver.addAlias("my-model", "some-canonical-id");
			expect(resolver.resolve("my-model")).toBe("some-canonical-id");
		});

		it("can overwrite an existing alias", () => {
			const resolver = new AliasResolver();
			resolver.addAlias("sonnet", "overridden-id");
			expect(resolver.resolve("sonnet")).toBe("overridden-id");
		});
	});

	describe("removeAlias", () => {
		it("removes an existing alias", () => {
			const resolver = new AliasResolver();
			resolver.removeAlias("sonnet");
			// After removal, resolve returns the input unchanged
			expect(resolver.resolve("sonnet")).toBe("sonnet");
		});

		it("is a no-op for non-existent aliases", () => {
			const resolver = new AliasResolver();
			// Should not throw
			resolver.removeAlias("non-existent-alias");
		});
	});

	describe("all", () => {
		it("returns the full alias map", () => {
			const resolver = new AliasResolver();
			const all = resolver.all();
			expect(all).toEqual(expect.objectContaining(DEFAULT_ALIASES));
		});

		it("includes custom aliases in the map", () => {
			const resolver = new AliasResolver({ "custom": "custom-model" });
			const all = resolver.all();
			expect(all["custom"]).toBe("custom-model");
			expect(all["sonnet"]).toBe("claude-sonnet-4-6");
		});
	});
});
