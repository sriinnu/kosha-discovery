/**
 * kosha-discovery — MiniMax provider discoverer.
 *
 * MiniMax serves international traffic from `api.minimax.io` and mainland
 * China from `api.minimaxi.com`. Same model IDs, separate accounts, separate
 * price sheets — so `minimax` and `minimax-cn` are distinct providers over one
 * classifier.
 * @module
 */

import type { OpenAICompatibleModel, ModelClassification } from "./openai-compatible.js";
import { OpenAICompatibleDiscoverer } from "./openai-compatible.js";

export class MiniMaxDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId: string;
	readonly providerName: string;
	readonly baseUrl: string;

	/**
	 * @param region - `"global"` targets `api.minimax.io`; `"cn"` targets
	 *                 `api.minimaxi.com` under the `minimax-cn` provider ID.
	 */
	constructor(region: "global" | "cn" = "global") {
		super();
		const cn = region === "cn";
		this.providerId = cn ? "minimax-cn" : "minimax";
		this.providerName = cn ? "MiniMax (China)" : "MiniMax";
		this.baseUrl = cn ? "https://api.minimaxi.com" : "https://api.minimax.io";
	}

	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		const lower = model.id.toLowerCase();
		return !model.id.startsWith("ft:") && !this.looksLikeReward(lower);
	}

	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();

		if (this.looksLikeEmbedding(lower) || lower.includes("embedding")) {
			return {
				originProvider: "minimax",
				mode: "embedding",
				capabilities: ["embedding"],
				contextWindow: model.context_window,
				maxOutputTokens: model.max_output_tokens,
				maxInputTokens: model.max_input_tokens,
				dimensions: model.output_vector_size,
			};
		}

		if (this.looksLikeAudio(lower)) {
			return {
				originProvider: "minimax",
				mode: "audio",
				capabilities: lower.includes("tts") ? ["text_to_speech"] : ["speech_to_text"],
				contextWindow: model.context_window,
				maxOutputTokens: model.max_output_tokens,
				maxInputTokens: model.max_input_tokens,
			};
		}

		const capabilities = ["chat", "function_calling"];
		if (this.looksLikeVision(lower)) capabilities.push("vision");
		if (this.looksLikeCode(lower)) capabilities.push("code");
		if (lower.includes("reason") || lower.includes("think")) capabilities.push("nlu");

		return {
			originProvider: "minimax",
			mode: "chat",
			capabilities,
			contextWindow: model.context_window,
			maxOutputTokens: model.max_output_tokens,
			maxInputTokens: model.max_input_tokens,
		};
	}
}

