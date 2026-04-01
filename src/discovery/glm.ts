/**
 * kosha-discovery — GLM (Zhipu) provider discoverer.
 *
 * GLM is exposed via Zhipu's OpenAI-compatible API surface.
 * @module
 */

import type { OpenAICompatibleModel, ModelClassification } from "./openai-compatible.js";
import { OpenAICompatibleDiscoverer } from "./openai-compatible.js";

export class GLMDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "glm";
	readonly providerName = "GLM (Zhipu)";
	readonly baseUrl = "https://open.bigmodel.cn/api/paas/v4";

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
		const originProvider = "zhipu";

		if (this.looksLikeEmbedding(lower) || lower.includes("embedding")) {
			return {
				originProvider,
				mode: "embedding",
				capabilities: ["embedding"],
				contextWindow: model.context_window,
				maxOutputTokens: model.max_output_tokens,
				maxInputTokens: model.max_input_tokens,
				dimensions: model.output_vector_size,
			};
		}

		const capabilities = ["chat", "function_calling"];
		if (this.looksLikeVision(lower) || lower.includes("glm-4v") || lower.includes("cogvlm")) capabilities.push("vision");
		if (this.looksLikeCode(lower) || lower.includes("codegeex")) capabilities.push("code");
		if (lower.includes("4") || lower.includes("air") || lower.includes("plus")) capabilities.push("nlu");

		return {
			originProvider,
			mode: "chat",
			capabilities,
			contextWindow: model.context_window,
			maxOutputTokens: model.max_output_tokens,
			maxInputTokens: model.max_input_tokens,
		};
	}
}

