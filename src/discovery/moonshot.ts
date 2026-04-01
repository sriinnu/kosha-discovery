/**
 * kosha-discovery — Moonshot/Kimi provider discoverer.
 *
 * Moonshot (Kimi) exposes an OpenAI-compatible API.
 * @module
 */

import type { OpenAICompatibleModel, ModelClassification } from "./openai-compatible.js";
import { OpenAICompatibleDiscoverer } from "./openai-compatible.js";

export class MoonshotDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "moonshot";
	readonly providerName = "Moonshot (Kimi)";
	readonly baseUrl = "https://api.moonshot.cn";

	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		return !model.id.startsWith("ft:");
	}

	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();

		if (this.looksLikeEmbedding(lower) || lower.includes("embedding")) {
			return {
				originProvider: "moonshot",
				mode: "embedding",
				capabilities: ["embedding"],
				contextWindow: model.context_window,
				maxOutputTokens: model.max_output_tokens,
				maxInputTokens: model.max_input_tokens,
				dimensions: model.output_vector_size,
			};
		}

		const capabilities = ["chat", "function_calling"];
		// Kimi's k2.5 family includes multimodal support.
		if (this.looksLikeVision(lower) || lower.includes("k2.5")) capabilities.push("vision");
		if (this.looksLikeCode(lower)) capabilities.push("code");
		if (lower.includes("thinking") || lower.includes("reason")) capabilities.push("nlu");

		return {
			originProvider: "moonshot",
			mode: "chat",
			capabilities,
			contextWindow: model.context_window,
			maxOutputTokens: model.max_output_tokens,
			maxInputTokens: model.max_input_tokens,
		};
	}
}

