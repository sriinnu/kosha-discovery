/**
 * Tests for inferTokenizerFamily — best-effort tokenizer-family inference
 * for API-served models (OpenAI, Anthropic, Google, Meta, Mistral, etc).
 */

import { describe, expect, it } from "vitest";
import { inferTokenizerFamily } from "../src/tokenizer-family.js";

// ---------------------------------------------------------------------------
// OpenAI family split: o200k_base vs cl100k_base
// ---------------------------------------------------------------------------

describe("inferTokenizerFamily — OpenAI", () => {
	it("returns o200k_base for gpt-4o variants", () => {
		expect(inferTokenizerFamily("openai", "gpt-4o")).toBe("o200k_base");
		expect(inferTokenizerFamily("openai", "gpt-4o-mini")).toBe("o200k_base");
		expect(inferTokenizerFamily("openai", "chatgpt-4o-latest")).toBe("o200k_base");
	});

	it("returns o200k_base for o1 / o3 / o4 reasoning families", () => {
		expect(inferTokenizerFamily("openai", "o1-preview")).toBe("o200k_base");
		expect(inferTokenizerFamily("openai", "o3-mini")).toBe("o200k_base");
		expect(inferTokenizerFamily("openai", "o4-mini")).toBe("o200k_base");
	});

	it("returns o200k_base for gpt-4.1 and gpt-5 lines", () => {
		expect(inferTokenizerFamily("openai", "gpt-4.1")).toBe("o200k_base");
		expect(inferTokenizerFamily("openai", "gpt-5")).toBe("o200k_base");
	});

	it("returns cl100k_base for legacy GPT-4 and GPT-3.5", () => {
		expect(inferTokenizerFamily("openai", "gpt-4")).toBe("cl100k_base");
		expect(inferTokenizerFamily("openai", "gpt-4-turbo")).toBe("cl100k_base");
		expect(inferTokenizerFamily("openai", "gpt-3.5-turbo")).toBe("cl100k_base");
	});

	it("returns cl100k_base for text-embedding-3 family", () => {
		expect(inferTokenizerFamily("openai", "text-embedding-3-small")).toBe("cl100k_base");
	});

	it("infers openai from id alone when origin is missing", () => {
		expect(inferTokenizerFamily(undefined, "gpt-4o-mini")).toBe("o200k_base");
		expect(inferTokenizerFamily(undefined, "gpt-3.5-turbo")).toBe("cl100k_base");
	});
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("inferTokenizerFamily — Anthropic", () => {
	it("returns claude for the full Claude family", () => {
		expect(inferTokenizerFamily("anthropic", "claude-opus-4-6")).toBe("claude");
		expect(inferTokenizerFamily("anthropic", "claude-sonnet-4-5")).toBe("claude");
		expect(inferTokenizerFamily("anthropic", "claude-3-5-haiku-20241022")).toBe("claude");
	});

	it("infers claude from id alone when origin is missing", () => {
		expect(inferTokenizerFamily(undefined, "claude-opus-4-6")).toBe("claude");
	});
});

// ---------------------------------------------------------------------------
// Google / Vertex
// ---------------------------------------------------------------------------

describe("inferTokenizerFamily — Google", () => {
	it("returns gemini for all Gemini variants", () => {
		expect(inferTokenizerFamily("google", "gemini-2.5-pro")).toBe("gemini");
		expect(inferTokenizerFamily("vertex", "gemini-1.5-flash")).toBe("gemini");
		expect(inferTokenizerFamily(undefined, "gemini-2.0-exp")).toBe("gemini");
	});
});

// ---------------------------------------------------------------------------
// Meta Llama
// ---------------------------------------------------------------------------

describe("inferTokenizerFamily — Meta Llama", () => {
	it("returns llama3 for Llama 3.x", () => {
		expect(inferTokenizerFamily("meta", "llama-3.3-70b")).toBe("llama3");
		expect(inferTokenizerFamily("meta", "llama3-8b")).toBe("llama3");
	});

	it("returns llama2 for Llama 2 and CodeLlama", () => {
		expect(inferTokenizerFamily("meta", "llama-2-70b")).toBe("llama2");
		expect(inferTokenizerFamily("meta", "codellama-34b")).toBe("llama2");
	});

	it("defaults unknown llama variants to llama3", () => {
		expect(inferTokenizerFamily("meta", "llama-maverick")).toBe("llama3");
	});
});

// ---------------------------------------------------------------------------
// Other families
// ---------------------------------------------------------------------------

describe("inferTokenizerFamily — other providers", () => {
	it("returns mistral for Mistral/Mixtral/Codestral/Pixtral", () => {
		expect(inferTokenizerFamily("mistral", "mistral-large-2411")).toBe("mistral");
		expect(inferTokenizerFamily("mistral", "mixtral-8x22b")).toBe("mistral");
		expect(inferTokenizerFamily("mistral", "codestral-2501")).toBe("mistral");
	});

	it("returns cohere for command/embed/rerank", () => {
		expect(inferTokenizerFamily("cohere", "command-r-plus")).toBe("cohere");
		expect(inferTokenizerFamily(undefined, "embed-english-v3.0")).toBe("cohere");
		expect(inferTokenizerFamily(undefined, "rerank-english-v3.0")).toBe("cohere");
	});

	it("returns deepseek for DeepSeek models", () => {
		expect(inferTokenizerFamily("deepseek", "deepseek-chat")).toBe("deepseek");
		expect(inferTokenizerFamily("deepseek", "deepseek-v3.1")).toBe("deepseek");
	});

	it("returns qwen for Alibaba Qwen models", () => {
		expect(inferTokenizerFamily("alibaba", "qwen-2.5-72b")).toBe("qwen");
		expect(inferTokenizerFamily(undefined, "qwen2.5-coder-32b")).toBe("qwen");
	});
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

describe("inferTokenizerFamily — fallback behavior", () => {
	it("returns undefined for unknown origin and unrecognized id", () => {
		expect(inferTokenizerFamily("unknown-provider", "some-mystery-model")).toBeUndefined();
	});

	it("returns undefined for empty model id", () => {
		expect(inferTokenizerFamily("openai", "")).toBeUndefined();
	});

	it("is case-insensitive on the model id", () => {
		expect(inferTokenizerFamily("openai", "GPT-4O-MINI")).toBe("o200k_base");
		expect(inferTokenizerFamily("anthropic", "CLAUDE-OPUS-4-6")).toBe("claude");
	});
});
