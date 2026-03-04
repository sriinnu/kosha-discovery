/**
 * kosha-discovery — Perplexity provider discoverer.
 *
 * Queries the Perplexity API `/v1/models` endpoint (OpenAI-compatible),
 * and maps results into {@link ModelCard} objects.
 *
 * Perplexity is a single-vendor catalog — all models are Perplexity's own
 * or their fine-tuned customisations (e.g. `r1-1776`, a DeepSeek R1 variant
 * tuned and served by Perplexity). The origin provider is always "perplexity".
 *
 * Sonar models carry Perplexity's unique real-time web search / grounding
 * feature, represented by the `web_search` capability flag.
 *
 * @module
 */

import type { ModelClassification, OpenAICompatibleModel } from "./openai-compatible.js";
import { OpenAICompatibleDiscoverer } from "./openai-compatible.js";

/**
 * Discovers models available through the Perplexity API.
 *
 * All models in the Perplexity catalog are served by Perplexity, so
 * `originProvider` is always `"perplexity"`. The catalog is clean
 * (no reward models, guard models, or embedding entries), so
 * {@link isRelevantModel} keeps every entry.
 *
 * Classification rules:
 * - Mode: always `"chat"`
 * - Base capabilities: `["chat", "function_calling"]`
 * - `"web_search"` added for any model whose ID contains `"sonar"`
 *   (Perplexity's grounding/search-augmented family)
 * - `"nlu"` added for any model whose ID contains `"pro"`
 *   (enhanced reasoning / language understanding tier)
 */
export class PerplexityDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "perplexity";
	readonly providerName = "Perplexity";
	readonly baseUrl = "https://api.perplexity.ai";

	/**
	 * All models in the Perplexity catalog are relevant.
	 *
	 * The catalog is curated and does not include reward models,
	 * embedding models, or other non-inference entries.
	 */
	protected isRelevantModel(_model: OpenAICompatibleModel): boolean {
		return true;
	}

	/**
	 * Classify a Perplexity model.
	 *
	 * Origin is always "perplexity". Mode is always "chat".
	 * Capabilities are built from the model ID:
	 * - `"chat"` and `"function_calling"` for all models
	 * - `"web_search"` for sonar family models (real-time grounding)
	 * - `"nlu"` for pro-tier models (enhanced NLU / reasoning)
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();
		const capabilities = this.buildCapabilities(lower);

		return {
			originProvider: "perplexity",
			mode: "chat",
			capabilities,
		};
	}

	/**
	 * Build the capability list for a model based on its ID.
	 *
	 * Rules applied in order (all are additive — multiple can apply):
	 * 1. `"chat"` — always included
	 * 2. `"function_calling"` — always included (all Perplexity models support it)
	 * 3. `"web_search"` — added when the model ID contains `"sonar"`
	 * 4. `"nlu"` — added when the model ID contains `"pro"`
	 */
	private buildCapabilities(lower: string): string[] {
		const caps: string[] = ["chat", "function_calling"];

		// Sonar models have built-in real-time web search / grounding
		if (lower.includes("sonar")) {
			caps.push("web_search");
		}

		// Pro-tier models have enhanced NLU / reasoning capabilities
		if (lower.includes("pro")) {
			caps.push("nlu");
		}

		return caps;
	}
}
