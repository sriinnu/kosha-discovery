/**
 * kosha-discovery — Groq provider discoverer.
 *
 * Queries the Groq `/v1/models` endpoint (OpenAI-compatible),
 * and maps models into {@link ModelCard} objects.
 *
 * Groq uses flat model IDs without vendor prefixes (e.g. `llama-3.3-70b-versatile`,
 * `mixtral-8x7b-32768`), so origin provider is inferred from name heuristics.
 * @module
 */

import type { ModelMode } from "../types.js";
import { OpenAICompatibleDiscoverer, type OpenAICompatibleModel, type ModelClassification } from "./openai-compatible.js";

/**
 * Discovers models available through the Groq API.
 *
 * Groq hosts a curated catalog of open-source models served via its
 * LPU Inference Engine. Model IDs are flat (no vendor prefix), so
 * origin provider is inferred from name heuristics.
 */
export class GroqDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "groq";
	readonly providerName = "Groq";
	readonly baseUrl = "https://api.groq.com/openai";

	/**
	 * Classify a Groq model: determine origin provider, mode, and capabilities.
	 *
	 * Groq has a curated catalog of open-source models, so all models are kept
	 * (no filter needed). Origin is inferred from keywords in the model ID.
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();
		const originProvider = this.inferOriginFromKeywords(
			lower,
			[
				["deepseek", "deepseek"],
				["mixtral", "mistral"],
				["mistral", "mistral"],
				["gemma", "google"],
				["qwen", "qwen"],
				["whisper", "openai"],
				["llama", "meta"],
			],
			"groq",
		);

		const mode = this.inferMode(lower);
		const capabilities = this.inferCapabilities(lower);

		return {
			originProvider,
			mode,
			capabilities,
			contextWindow: model.context_window,
		};
	}

	/** Map a model ID to its primary {@link ModelMode}. */
	private inferMode(lower: string): ModelMode {
		if (lower.includes("whisper")) return "audio";
		return "chat";
	}

	/**
	 * Infer capability flags from the model ID.
	 *
	 * Key heuristics:
	 * - Whisper models get "speech_to_text" only
	 * - Guard models get "chat" + "moderation"
	 * - Vision models get "vision" added
	 * - Code-specialized models get "code" added
	 * - Most chat models get "function_calling" (Groq supports it broadly)
	 */
	private inferCapabilities(lower: string): string[] {
		// Audio / speech-to-text models
		if (lower.includes("whisper")) {
			return ["speech_to_text"];
		}

		const caps: string[] = ["chat"];

		// Guard / safety models
		if (lower.includes("guard")) {
			caps.push("moderation");
			return caps;
		}

		// Vision models
		if (this.looksLikeVision(lower)) {
			caps.push("vision");
		}

		// Code-specialized models
		if (this.looksLikeCode(lower)) {
			caps.push("code");
		}

		// Function calling — Groq supports it broadly for chat models
		caps.push("function_calling");

		return caps;
	}
}
