/**
 * Tests covering the 2026+ litellm enrichment surface:
 *   - multimodal pricing (image, audio, video, character)
 *   - tiered long-context pricing
 *   - tool dialect + structured-output mode inference
 *   - parallel tool-call flag
 *   - deprecation / sunset metadata
 *
 * These fields were added alongside the tokenizer-family inference pass so
 * that ModelCards stay useful for routing, cost estimation, and
 * deprecation warnings across the full modern model catalogue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiteLLMEnricher } from "../../src/enrichment/litellm.js";
import type { ModelCard } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixture: a mixed-modality catalogue snippet.
// ---------------------------------------------------------------------------

const TOMORROW = new Date(Date.now() + 60 * 60 * 24 * 1000).toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 60 * 60 * 24 * 1000).toISOString().slice(0, 10);

const LITELLM_DATA: Record<string, any> = {
	// Modern frontier chat model with tool calling + structured output.
	"openai/gpt-4o-2024-08-06": {
		max_tokens: 16384,
		max_input_tokens: 128000,
		max_output_tokens: 16384,
		input_cost_per_token: 0.0000025,
		output_cost_per_token: 0.00001,
		input_cost_per_image: 0.003613,
		litellm_provider: "openai",
		mode: "chat",
		supports_function_calling: true,
		supports_parallel_function_calling: true,
		supports_vision: true,
		supports_response_schema: true,
	},
	// Audio-native model with per-token audio pricing.
	"openai/gpt-4o-realtime-preview": {
		max_input_tokens: 128000,
		max_output_tokens: 4096,
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.00002,
		input_cost_per_audio_token: 0.0001,
		output_cost_per_audio_token: 0.0002,
		litellm_provider: "openai",
		mode: "chat",
		supports_function_calling: true,
		supports_audio_input: true,
		supports_audio_output: true,
	},
	// TTS model — per-second audio output billing, no token pricing.
	"elevenlabs-tts-v2": {
		output_cost_per_audio_per_second: 0.00018,
		litellm_provider: "elevenlabs",
		mode: "audio_speech",
	},
	// Gemini 2.5 Pro — tiered long-context pricing + video.
	"gemini-2.5-pro": {
		max_input_tokens: 2000000,
		max_output_tokens: 8192,
		input_cost_per_token: 0.00000125,
		output_cost_per_token: 0.000005,
		input_cost_per_token_above_128k_tokens: 0.0000025,
		output_cost_per_token_above_128k_tokens: 0.00001,
		input_cost_per_video_per_second: 0.00002,
		litellm_provider: "vertex_ai",
		mode: "chat",
		supports_function_calling: true,
		supports_response_schema: true,
		supports_video_input: true,
		supports_vision: true,
	},
	// Vertex AI text-bison — per-character billing (≈ $2.50 / 1M chars).
	"textembedding-gecko@003": {
		input_cost_per_character: 0.0000025,
		output_cost_per_character: 0,
		litellm_provider: "vertex_ai",
		mode: "embedding",
	},
	// Deprecated model — past sunset date.
	"gpt-4-0613": {
		max_input_tokens: 8192,
		max_output_tokens: 4096,
		input_cost_per_token: 0.00003,
		output_cost_per_token: 0.00006,
		deprecation_date: YESTERDAY,
		litellm_provider: "openai",
		mode: "chat",
		supports_function_calling: true,
	},
	// Scheduled-for-deprecation model.
	"gpt-4-1106-preview": {
		max_input_tokens: 128000,
		max_output_tokens: 4096,
		input_cost_per_token: 0.00001,
		output_cost_per_token: 0.00003,
		deprecation_date: TOMORROW,
		litellm_provider: "openai",
		mode: "chat",
		supports_function_calling: true,
	},
};

function makeModel(overrides: Partial<ModelCard> = {}): ModelCard {
	return {
		id: "openai/gpt-4o-2024-08-06",
		name: "GPT-4o (2024-08-06)",
		provider: "openai",
		originProvider: "openai",
		mode: "chat",
		capabilities: [],
		contextWindow: 0,
		maxOutputTokens: 0,
		aliases: [],
		discoveredAt: Date.now(),
		source: "api",
		...overrides,
	};
}

// ---------------------------------------------------------------------------

describe("LiteLLMEnricher — 2026+ fields", () => {
	let enricher: LiteLLMEnricher;

	beforeEach(() => {
		enricher = new LiteLLMEnricher();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(LITELLM_DATA), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------------------
	// Multimodal pricing
	// -----------------------------------------------------------------------

	describe("multimodal pricing", () => {
		it("fills per-image input cost", async () => {
			const [enriched] = await enricher.enrich([makeModel()]);
			expect(enriched.pricing?.imageInputPerImage).toBe(0.003613);
		});

		it("converts per-audio-token cost into per-million units", async () => {
			const model = makeModel({
				id: "openai/gpt-4o-realtime-preview",
				name: "GPT-4o Realtime",
			});
			const [enriched] = await enricher.enrich([model]);
			expect(enriched.pricing?.audioInputPerMillion).toBeCloseTo(100, 5);
			expect(enriched.pricing?.audioOutputPerMillion).toBeCloseTo(200, 5);
		});

		it("fills per-second audio output for TTS-style billing", async () => {
			const model = makeModel({
				id: "elevenlabs-tts-v2",
				name: "ElevenLabs TTS v2",
				provider: "elevenlabs",
				originProvider: "elevenlabs",
				mode: "audio",
			});
			const [enriched] = await enricher.enrich([model]);
			expect(enriched.pricing?.audioOutputPerSecond).toBe(0.00018);
		});

		it("fills per-second video input + tiered long-context for Gemini", async () => {
			const model = makeModel({
				id: "gemini-2.5-pro",
				name: "Gemini 2.5 Pro",
				provider: "google",
				originProvider: "google",
			});
			const [enriched] = await enricher.enrich([model]);
			expect(enriched.pricing?.videoInputPerSecond).toBe(0.00002);
			expect(enriched.pricing?.longContextInputPerMillion).toBeCloseTo(2.5, 5);
			expect(enriched.pricing?.longContextOutputPerMillion).toBeCloseTo(10, 5);
			expect(enriched.pricing?.longContextThresholdTokens).toBe(128000);
		});

		it("fills per-character pricing for character-billed providers", async () => {
			const model = makeModel({
				id: "textembedding-gecko@003",
				name: "Gecko 003",
				provider: "vertex_ai",
				originProvider: "google",
				mode: "embedding",
			});
			const [enriched] = await enricher.enrich([model]);
			expect(enriched.pricing?.inputPerMillionCharacters).toBeCloseTo(2.5, 5);
		});
	});

	// -----------------------------------------------------------------------
	// Tool dialect + structured output + parallel tool calls
	// -----------------------------------------------------------------------

	describe("tool dialect & structured output inference", () => {
		it("fills toolDialect from origin + id when missing", async () => {
			const [enriched] = await enricher.enrich([makeModel()]);
			expect(enriched.toolDialect).toBe("openai-tools");
		});

		it("does not overwrite an explicitly-set toolDialect", async () => {
			const [enriched] = await enricher.enrich([
				makeModel({ toolDialect: "openai-responses" }),
			]);
			expect(enriched.toolDialect).toBe("openai-responses");
		});

		it("fills structuredOutputModes based on the inference heuristic", async () => {
			const [enriched] = await enricher.enrich([makeModel()]);
			expect(enriched.structuredOutputModes).toEqual(["json-schema", "json-mode"]);
		});

		it("respects litellm's supports_parallel_function_calling flag", async () => {
			const [enriched] = await enricher.enrich([makeModel()]);
			expect(enriched.supportsParallelToolCalls).toBe(true);
		});

		it("surfaces audio + video + reasoning capability flags on the capabilities array", async () => {
			const realtime = makeModel({
				id: "openai/gpt-4o-realtime-preview",
				name: "GPT-4o Realtime",
			});
			const [enriched] = await enricher.enrich([realtime]);
			expect(enriched.capabilities).toContain("audio_input");
			expect(enriched.capabilities).toContain("audio_output");
		});
	});

	// -----------------------------------------------------------------------
	// Deprecation / status metadata
	// -----------------------------------------------------------------------

	describe("deprecation metadata", () => {
		it("marks past-date models as retired", async () => {
			const model = makeModel({ id: "gpt-4-0613", provider: "openai" });
			const [enriched] = await enricher.enrich([model]);
			expect(enriched.deprecationDate).toBe(YESTERDAY);
			expect(enriched.status).toBe("retired");
		});

		it("marks future-date models as deprecated", async () => {
			const model = makeModel({ id: "gpt-4-1106-preview", provider: "openai" });
			const [enriched] = await enricher.enrich([model]);
			expect(enriched.deprecationDate).toBe(TOMORROW);
			expect(enriched.status).toBe("deprecated");
		});

		it("defaults status to active when no deprecation date is set", async () => {
			const [enriched] = await enricher.enrich([makeModel()]);
			expect(enriched.status).toBe("active");
			expect(enriched.deprecationDate).toBeUndefined();
		});

		it("does not overwrite explicit status / deprecationDate", async () => {
			const [enriched] = await enricher.enrich([
				makeModel({
					id: "gpt-4-0613",
					provider: "openai",
					status: "preview",
					deprecationDate: "2030-01-01",
				}),
			]);
			expect(enriched.status).toBe("preview");
			expect(enriched.deprecationDate).toBe("2030-01-01");
		});
	});
});
