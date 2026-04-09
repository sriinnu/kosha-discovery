/**
 * kosha-discovery — Z.AI provider discoverer.
 *
 * Z.AI exposes an OpenAI-compatible API surface.
 * @module
 */

import type { OpenAICompatibleModel, ModelClassification } from "./openai-compatible.js";
import { OpenAICompatibleDiscoverer } from "./openai-compatible.js";

export class ZAIDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "zai";
	readonly providerName = "Z.AI";
	readonly baseUrl = "https://api.z.ai/api/paas/v4";

	protected modelListEndpoints(): string[] {
		return [
			`${this.baseUrl}/models`,
			`${this.baseUrl}/v1/models`,
		];
	}

	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		return !model.id.startsWith("ft:");
	}

	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();

		if (this.looksLikeEmbedding(lower) || lower.includes("embedding")) {
			return {
				originProvider: "zai",
				mode: "embedding",
				capabilities: ["embedding"],
				contextWindow: model.context_window,
				maxOutputTokens: model.max_output_tokens,
				maxInputTokens: model.max_input_tokens,
				dimensions: model.output_vector_size,
			};
		}

		const capabilities = ["chat", "function_calling"];
		if (this.looksLikeVision(lower)) capabilities.push("vision");
		if (this.looksLikeCode(lower)) capabilities.push("code");
		if (lower.includes("reason") || lower.includes("thinking")) capabilities.push("nlu");

		return {
			originProvider: "zai",
			mode: "chat",
			capabilities,
			contextWindow: model.context_window,
			maxOutputTokens: model.max_output_tokens,
			maxInputTokens: model.max_input_tokens,
		};
	}
}

