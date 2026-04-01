/**
 * kosha-discovery — DeepSeek provider discoverer.
 *
 * DeepSeek exposes an OpenAI-compatible API at api.deepseek.com.
 * This discoverer adds first-class direct discovery for DeepSeek models.
 * @module
 */

import type { OpenAICompatibleModel, ModelClassification } from "./openai-compatible.js";
import { OpenAICompatibleDiscoverer } from "./openai-compatible.js";

export class DeepSeekDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "deepseek";
	readonly providerName = "DeepSeek";
	readonly baseUrl = "https://api.deepseek.com";

	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		const lower = model.id.toLowerCase();
		return !model.id.startsWith("ft:") && !this.looksLikeReward(lower);
	}

	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();

		if (this.looksLikeEmbedding(lower) || lower.includes("embedding")) {
			return {
				originProvider: "deepseek",
				mode: "embedding",
				capabilities: ["embedding"],
				contextWindow: model.context_window,
				maxOutputTokens: model.max_output_tokens,
				maxInputTokens: model.max_input_tokens,
				dimensions: model.output_vector_size,
			};
		}

		const capabilities = ["chat", "function_calling", "nlu"];
		if (this.looksLikeCode(lower)) capabilities.push("code");
		if (this.looksLikeVision(lower)) capabilities.push("vision");

		return {
			originProvider: "deepseek",
			mode: "chat",
			capabilities,
			contextWindow: model.context_window,
			maxOutputTokens: model.max_output_tokens,
			maxInputTokens: model.max_input_tokens,
		};
	}
}

