/**
 * kosha-discovery — Moonshot/Kimi provider discoverer.
 *
 * Moonshot (Kimi) exposes an OpenAI-compatible API on two independent hosts:
 * `api.moonshot.ai` for international accounts and `api.moonshot.cn` for
 * mainland China. They take different keys and publish different prices for
 * the same model IDs, so kosha treats them as two providers (`moonshot` and
 * `moonshot-cn`) sharing one classifier — collapsing them would make a model's
 * price depend on which host answered last.
 * @module
 */

import type { OpenAICompatibleModel, ModelClassification } from "./openai-compatible.js";
import { OpenAICompatibleDiscoverer } from "./openai-compatible.js";

export class MoonshotDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId: string;
	readonly providerName: string;
	readonly baseUrl: string;

	/**
	 * @param region - `"global"` targets `api.moonshot.ai`; `"cn"` targets
	 *                 `api.moonshot.cn` under the `moonshot-cn` provider ID.
	 */
	constructor(region: "global" | "cn" = "global") {
		super();
		const cn = region === "cn";
		this.providerId = cn ? "moonshot-cn" : "moonshot";
		this.providerName = cn ? "Moonshot (Kimi, China)" : "Moonshot (Kimi)";
		this.baseUrl = cn ? "https://api.moonshot.cn" : "https://api.moonshot.ai";
	}

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

