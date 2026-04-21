/**
 * Tests for the model-features inference helpers:
 *   - inferToolDialect
 *   - inferStructuredOutputModes
 *   - inferParallelToolCalls
 *
 * These helpers are best-effort heuristics; the tests lock in the intended
 * mappings for well-known 2025/2026 model families so that catalog consumers
 * can rely on the default hints when a provider API doesn't surface them.
 */

import { describe, expect, it } from "vitest";
import {
	inferParallelToolCalls,
	inferStructuredOutputModes,
	inferToolDialect,
} from "../src/model-features.js";

// ---------------------------------------------------------------------------
// inferToolDialect
// ---------------------------------------------------------------------------

describe("inferToolDialect — OpenAI", () => {
	it("returns openai-responses for the GPT-4.1 / GPT-5 / o-series frontier", () => {
		expect(inferToolDialect("openai", "gpt-4.1")).toBe("openai-responses");
		expect(inferToolDialect("openai", "gpt-5")).toBe("openai-responses");
		expect(inferToolDialect("openai", "o1-preview")).toBe("openai-responses");
		expect(inferToolDialect("openai", "o3-mini")).toBe("openai-responses");
		expect(inferToolDialect("openai", "o4-mini")).toBe("openai-responses");
	});

	it("returns openai-tools for GPT-4o / GPT-4 / GPT-3.5 with modern tool support", () => {
		expect(inferToolDialect("openai", "gpt-4o")).toBe("openai-tools");
		expect(inferToolDialect("openai", "gpt-4o-mini")).toBe("openai-tools");
		expect(inferToolDialect("openai", "gpt-4")).toBe("openai-tools");
		expect(inferToolDialect("openai", "gpt-4-turbo")).toBe("openai-tools");
		expect(inferToolDialect("openai", "gpt-3.5-turbo-1106")).toBe("openai-tools");
	});

	it("returns none for legacy / non-tool-capable OpenAI models", () => {
		expect(inferToolDialect("openai", "gpt-3.5-turbo-0301")).toBe("none");
		expect(inferToolDialect("openai", "gpt-3.5-turbo-0613")).toBe("none");
		expect(inferToolDialect("openai", "text-davinci-003")).toBe("none");
		expect(inferToolDialect("openai", "ada-001")).toBe("none");
	});

	it("returns none for embedding / image / audio models regardless of origin", () => {
		expect(inferToolDialect("openai", "text-embedding-3-small")).toBe("none");
		expect(inferToolDialect("openai", "dall-e-3")).toBe("none");
		expect(inferToolDialect("openai", "whisper-1")).toBe("none");
		expect(inferToolDialect("openai", "tts-1")).toBe("none");
	});
});

describe("inferToolDialect — Anthropic", () => {
	it("returns anthropic-tools for Claude 3 and later", () => {
		expect(inferToolDialect("anthropic", "claude-opus-4-6")).toBe("anthropic-tools");
		expect(inferToolDialect("anthropic", "claude-sonnet-4-5")).toBe("anthropic-tools");
		expect(inferToolDialect("anthropic", "claude-3-5-sonnet-20241022")).toBe("anthropic-tools");
	});

	it("returns none for legacy Claude 1 / 2 / instant models", () => {
		expect(inferToolDialect("anthropic", "claude-instant-1.2")).toBe("none");
		expect(inferToolDialect("anthropic", "claude-2.0")).toBe("none");
	});
});

describe("inferToolDialect — Google", () => {
	it("returns gemini-functions for Gemini 1.5+ and 2.x", () => {
		expect(inferToolDialect("google", "gemini-1.5-pro")).toBe("gemini-functions");
		expect(inferToolDialect("google", "gemini-2.5-pro")).toBe("gemini-functions");
		expect(inferToolDialect("vertex", "gemini-2.0-flash-exp")).toBe("gemini-functions");
	});

	it("returns none for legacy PaLM / Bison / Gecko", () => {
		expect(inferToolDialect("google", "chat-bison-001")).toBe("none");
		expect(inferToolDialect("google", "textembedding-gecko")).toBe("none");
		expect(inferToolDialect("google", "palm-text-2")).toBe("none");
	});
});

describe("inferToolDialect — other providers", () => {
	it("returns cohere-tools for Command family", () => {
		expect(inferToolDialect("cohere", "command-r-plus")).toBe("cohere-tools");
		expect(inferToolDialect(undefined, "command-r-08-2024")).toBe("cohere-tools");
	});

	it("returns mistral-tools for modern Mistral models", () => {
		expect(inferToolDialect("mistral", "mistral-large-2411")).toBe("mistral-tools");
		expect(inferToolDialect("mistral", "codestral-2501")).toBe("mistral-tools");
	});

	it("returns none for legacy Mistral base models", () => {
		expect(inferToolDialect("mistral", "mistral-7b-instruct-v0.2")).toBe("none");
		expect(inferToolDialect("mistral", "mistral-tiny-2312")).toBe("none");
	});

	it("returns llama3-tools for Llama 3.1+ instruct tunes", () => {
		expect(inferToolDialect("meta", "llama-3.1-70b-instruct")).toBe("llama3-tools");
		expect(inferToolDialect("meta", "llama-3.3-70b-instruct")).toBe("llama3-tools");
		expect(inferToolDialect("meta", "llama-3-405b-instruct")).toBe("llama3-tools");
	});

	it("returns openai-tools for DeepSeek V3 / R1 / chat variants", () => {
		expect(inferToolDialect("deepseek", "deepseek-v3")).toBe("openai-tools");
		expect(inferToolDialect("deepseek", "deepseek-r1")).toBe("openai-tools");
		expect(inferToolDialect("deepseek", "deepseek-chat")).toBe("openai-tools");
	});

	it("returns openai-tools for Qwen 2.5 / 3.x", () => {
		expect(inferToolDialect("alibaba", "qwen2.5-72b-instruct")).toBe("openai-tools");
		expect(inferToolDialect(undefined, "qwen3-72b")).toBe("openai-tools");
	});

	it("returns undefined for unknown provider + unrecognized id", () => {
		expect(inferToolDialect("unknown", "mystery-model")).toBeUndefined();
		expect(inferToolDialect(undefined, "")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// inferStructuredOutputModes
// ---------------------------------------------------------------------------

describe("inferStructuredOutputModes — OpenAI", () => {
	it("returns json-schema + json-mode for GPT-4o / GPT-4.1 / o-series", () => {
		expect(inferStructuredOutputModes("openai", "gpt-4o")).toEqual(["json-schema", "json-mode"]);
		expect(inferStructuredOutputModes("openai", "gpt-4.1")).toEqual(["json-schema", "json-mode"]);
		expect(inferStructuredOutputModes("openai", "o3-mini")).toEqual(["json-schema", "json-mode"]);
	});

	it("returns only json-mode for GPT-4 turbo / GPT-3.5-turbo-1106", () => {
		expect(inferStructuredOutputModes("openai", "gpt-4-turbo")).toEqual(["json-mode"]);
		expect(inferStructuredOutputModes("openai", "gpt-3.5-turbo-1106")).toEqual(["json-mode"]);
	});

	it("returns empty for embedding / image / audio models", () => {
		expect(inferStructuredOutputModes("openai", "text-embedding-3-small")).toEqual([]);
		expect(inferStructuredOutputModes("openai", "dall-e-3")).toEqual([]);
		expect(inferStructuredOutputModes("openai", "whisper-1")).toEqual([]);
	});
});

describe("inferStructuredOutputModes — Anthropic", () => {
	it("returns tool-choice + xml for Claude 3+", () => {
		expect(inferStructuredOutputModes("anthropic", "claude-opus-4-6")).toEqual([
			"tool-choice",
			"xml",
		]);
	});

	it("returns only xml for legacy Claude 1/2", () => {
		expect(inferStructuredOutputModes("anthropic", "claude-2.0")).toEqual(["xml"]);
	});
});

describe("inferStructuredOutputModes — Google", () => {
	it("returns response-schema for Gemini 1.5+ / 2.x", () => {
		expect(inferStructuredOutputModes("google", "gemini-1.5-pro")).toEqual(["response-schema"]);
		expect(inferStructuredOutputModes("vertex", "gemini-2.5-pro")).toEqual(["response-schema"]);
	});

	it("returns empty for Gemini 1.0 and legacy Bison", () => {
		expect(inferStructuredOutputModes("google", "gemini-1.0-pro")).toEqual([]);
		expect(inferStructuredOutputModes("google", "chat-bison-001")).toEqual([]);
	});
});

describe("inferStructuredOutputModes — other providers", () => {
	it("returns response-format for Cohere Command", () => {
		expect(inferStructuredOutputModes("cohere", "command-r-plus")).toEqual(["response-format"]);
	});

	it("returns json-schema + json-mode for Mistral Large 2411", () => {
		expect(inferStructuredOutputModes("mistral", "mistral-large-2411")).toEqual([
			"json-schema",
			"json-mode",
		]);
	});

	it("returns grammar + json-mode for local runtimes", () => {
		expect(inferStructuredOutputModes("ollama", "llama3.3:70b")).toEqual([
			"grammar",
			"json-mode",
		]);
		expect(inferStructuredOutputModes("llama.cpp", "phi-3")).toEqual(["grammar", "json-mode"]);
	});

	it("returns tool-choice for Llama 3.1+ instruct", () => {
		expect(inferStructuredOutputModes("meta", "llama-3.1-70b-instruct")).toEqual(["tool-choice"]);
	});

	it("returns empty array for unknown providers", () => {
		expect(inferStructuredOutputModes("unknown", "mystery")).toEqual([]);
		expect(inferStructuredOutputModes(undefined, "")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// inferParallelToolCalls
// ---------------------------------------------------------------------------

describe("inferParallelToolCalls", () => {
	it("returns true for modern frontier models with tool calling", () => {
		expect(inferParallelToolCalls("openai", "gpt-4o")).toBe(true);
		expect(inferParallelToolCalls("openai", "gpt-4.1")).toBe(true);
		expect(inferParallelToolCalls("anthropic", "claude-opus-4-6")).toBe(true);
		expect(inferParallelToolCalls("google", "gemini-2.5-pro")).toBe(true);
	});

	it("returns false for legacy serial-only tool-capable models", () => {
		expect(inferParallelToolCalls("openai", "gpt-3.5-turbo-1106")).toBe(false);
		expect(inferParallelToolCalls("google", "gemini-1.0-pro")).toBe(false);
	});

	it("returns undefined when the model does not support tool calling at all", () => {
		expect(inferParallelToolCalls("openai", "text-embedding-3-small")).toBeUndefined();
		expect(inferParallelToolCalls("anthropic", "claude-2.0")).toBeUndefined();
		expect(inferParallelToolCalls("openai", "dall-e-3")).toBeUndefined();
	});
});
