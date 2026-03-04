/**
 * kosha-discovery — Mistral AI provider discoverer.
 *
 * Queries the Mistral AI `/v1/models` endpoint, filters relevant models,
 * and maps them into {@link ModelCard} objects.
 *
 * Mistral's catalog is first-party only — all models are Mistral's own,
 * so `originProvider` is always `"mistral"`.
 * @module
 */

import type { OpenAICompatibleModel, ModelClassification } from "./openai-compatible.js";
import { OpenAICompatibleDiscoverer } from "./openai-compatible.js";

/**
 * Discovers models available through the Mistral AI API.
 *
 * Mistral's catalog is first-party — model IDs are flat strings such as
 * `mistral-large-latest`, `codestral-latest`, and `mistral-embed`. The
 * discoverer infers mode and capabilities from patterns in the model ID.
 */
export class MistralDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "mistral";
	readonly providerName = "Mistral AI";
	readonly baseUrl = "https://api.mistral.ai";

	/**
	 * Determine whether a model ID represents a model we want to track.
	 *
	 * We keep all standard Mistral models and filter out:
	 * - Fine-tuned model snapshots (id starts with "ft:")
	 */
	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		// Skip fine-tuned model snapshots
		if (model.id.startsWith("ft:")) return false;

		return true;
	}

	/**
	 * Classify a Mistral model: determine origin, mode, and capabilities.
	 *
	 * Key heuristics:
	 * - Origin is always "mistral"
	 * - Embedding models get mode "embedding"
	 * - Chat models get mode "chat"
	 * - Models containing "pixtral" get "vision" capability
	 * - Models containing "codestral" get "code" capability
	 * - All chat models get "function_calling" (Mistral supports it across their lineup)
	 * - Large models get "nlu"
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const id = model.id;
		const lower = id.toLowerCase();

		// Determine mode
		const mode = lower.includes("embed") ? "embedding" : "chat";

		// Determine capabilities
		const capabilities: string[] = [];

		if (mode === "embedding") {
			capabilities.push("embedding");
		} else {
			// Chat models get function_calling
			capabilities.push("chat");
			capabilities.push("function_calling");

			// Vision models
			if (this.looksLikeVision(lower)) {
				capabilities.push("vision");
			}

			// Code-specialized models
			if (this.looksLikeCode(lower)) {
				capabilities.push("code");
			}

			// Large models get NLU capability
			if (lower.includes("large")) {
				capabilities.push("nlu");
			}
		}

		return {
			originProvider: "mistral",
			mode,
			capabilities,
			contextWindow: model.context_window,
		};
	}
}
