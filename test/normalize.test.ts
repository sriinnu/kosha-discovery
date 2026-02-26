/**
 * Tests for the model-ID normalization utilities (extractOriginProvider, normalizeModelId).
 */

import { describe, expect, it } from "vitest";
import { extractOriginProvider, normalizeModelId } from "../src/normalize.js";

// ---------------------------------------------------------------------------
// extractOriginProvider
// ---------------------------------------------------------------------------

describe("extractOriginProvider", () => {
	describe("slash-prefixed model IDs", () => {
		it("extracts anthropic from anthropic/claude-opus-4-6", () => {
			expect(extractOriginProvider("anthropic/claude-opus-4-6")).toBe("anthropic");
		});

		it("extracts openai from openai/gpt-4o", () => {
			expect(extractOriginProvider("openai/gpt-4o")).toBe("openai");
		});

		it("extracts google from google/gemini-2.5-pro", () => {
			expect(extractOriginProvider("google/gemini-2.5-pro")).toBe("google");
		});

		it("extracts meta from meta-llama/llama-3.3-70b", () => {
			expect(extractOriginProvider("meta-llama/llama-3.3-70b")).toBe("meta");
		});

		it("extracts mistral from mistralai/mistral-large", () => {
			expect(extractOriginProvider("mistralai/mistral-large")).toBe("mistral");
		});

		it("extracts cohere from cohere/command-r-plus", () => {
			expect(extractOriginProvider("cohere/command-r-plus")).toBe("cohere");
		});

		it("extracts deepseek from deepseek/deepseek-r1", () => {
			expect(extractOriginProvider("deepseek/deepseek-r1")).toBe("deepseek");
		});

		it("extracts qwen from qwen/qwen3-8b", () => {
			expect(extractOriginProvider("qwen/qwen3-8b")).toBe("qwen");
		});

		it("extracts xai from x-ai/grok-2", () => {
			expect(extractOriginProvider("x-ai/grok-2")).toBe("xai");
		});

		it("extracts amazon from amazon-nova/nova-pro", () => {
			expect(extractOriginProvider("amazon-nova/nova-pro")).toBe("amazon");
		});
	});

	describe("bare model IDs (pattern matching)", () => {
		it("recognises claude models as anthropic", () => {
			expect(extractOriginProvider("claude-opus-4-6")).toBe("anthropic");
			expect(extractOriginProvider("claude-sonnet-4-6")).toBe("anthropic");
			expect(extractOriginProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
		});

		it("recognises gpt models as openai", () => {
			expect(extractOriginProvider("gpt-4o")).toBe("openai");
			expect(extractOriginProvider("gpt-4o-2024-11-20")).toBe("openai");
		});

		it("recognises o-series models as openai", () => {
			expect(extractOriginProvider("o1")).toBe("openai");
			expect(extractOriginProvider("o3")).toBe("openai");
			expect(extractOriginProvider("o3-mini")).toBe("openai");
			expect(extractOriginProvider("o4-mini")).toBe("openai");
		});

		it("recognises dall-e as openai", () => {
			expect(extractOriginProvider("dall-e-3")).toBe("openai");
		});

		it("recognises whisper/tts as openai", () => {
			expect(extractOriginProvider("whisper-1")).toBe("openai");
			expect(extractOriginProvider("tts-1-hd")).toBe("openai");
		});

		it("recognises gemini models as google", () => {
			expect(extractOriginProvider("gemini-2.5-pro-preview-05-06")).toBe("google");
			expect(extractOriginProvider("gemini-2.0-flash")).toBe("google");
		});

		it("recognises llama models as meta", () => {
			expect(extractOriginProvider("llama3.3:latest")).toBe("meta");
			expect(extractOriginProvider("llama-3.3-70b-instruct")).toBe("meta");
		});

		it("recognises mistral/codestral/pixtral as mistral", () => {
			expect(extractOriginProvider("mistral-large-2411")).toBe("mistral");
			expect(extractOriginProvider("codestral-latest")).toBe("mistral");
			expect(extractOriginProvider("pixtral-12b")).toBe("mistral");
		});

		it("recognises command models as cohere", () => {
			expect(extractOriginProvider("command-r-plus")).toBe("cohere");
		});

		it("recognises deepseek models", () => {
			expect(extractOriginProvider("deepseek-r1:latest")).toBe("deepseek");
		});

		it("recognises qwen models", () => {
			expect(extractOriginProvider("qwen3:8b")).toBe("qwen");
		});
	});

	describe("edge cases", () => {
		it("returns undefined for unknown models", () => {
			expect(extractOriginProvider("unknown-model-xyz")).toBeUndefined();
		});

		it("returns undefined for empty string", () => {
			expect(extractOriginProvider("")).toBeUndefined();
		});

		it("handles unknown slash-prefixed models by falling through to pattern", () => {
			// unknown-vendor/ prefix but the bare name matches a pattern
			expect(extractOriginProvider("some-vendor/claude-opus-4-6")).toBe("anthropic");
		});
	});
});

// ---------------------------------------------------------------------------
// normalizeModelId
// ---------------------------------------------------------------------------

describe("normalizeModelId", () => {
	describe("stripping provider prefix", () => {
		it("strips anthropic/ prefix", () => {
			expect(normalizeModelId("anthropic/claude-opus-4-6")).toBe("claude-opus-4-6");
		});

		it("strips openai/ prefix", () => {
			expect(normalizeModelId("openai/gpt-4o")).toBe("gpt-4o");
		});

		it("strips meta-llama/ prefix", () => {
			expect(normalizeModelId("meta-llama/llama-3.3-70b-instruct")).toBe("llama-3.3-70b-instruct");
		});
	});

	describe("stripping date suffixes", () => {
		it("strips ISO date suffix -YYYY-MM-DD", () => {
			expect(normalizeModelId("gpt-4o-2024-11-20")).toBe("gpt-4o");
		});

		it("strips compact date suffix -YYYYMMDD", () => {
			expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
		});

		it("strips both prefix and date suffix", () => {
			expect(normalizeModelId("openai/gpt-4o-2024-11-20")).toBe("gpt-4o");
		});
	});

	describe("stripping Ollama colon-tags", () => {
		it("strips :latest", () => {
			expect(normalizeModelId("llama3.3:latest")).toBe("llama3.3");
		});

		it("strips :q4 quantization tags", () => {
			expect(normalizeModelId("deepseek-r1:q4")).toBe("deepseek-r1");
		});

		it("strips :8b parameter tags", () => {
			expect(normalizeModelId("qwen3:8b")).toBe("qwen3");
		});
	});

	describe("passthrough", () => {
		it("returns already-clean IDs unchanged", () => {
			expect(normalizeModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
		});

		it("returns empty string unchanged", () => {
			expect(normalizeModelId("")).toBe("");
		});
	});
});
