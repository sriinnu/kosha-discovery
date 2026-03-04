/**
 * kosha-discovery — Cerebras provider discoverer.
 *
 * Queries the Cerebras `/v1/models` endpoint (OpenAI-compatible),
 * and maps results into {@link ModelCard} objects.
 *
 * Cerebras hosts open-source models (Llama, Mistral, DeepSeek, Qwen) on
 * their fast inference hardware. Model IDs are flat (no vendor prefix),
 * e.g. `llama3.1-8b`, `llama-3.3-70b`, `deepseek-r1-distill-llama-70b`.
 *
 * @module
 */

import { OpenAICompatibleDiscoverer, type OpenAICompatibleModel, type ModelClassification } from "./openai-compatible.js";

/**
 * Keyword rules for inferring origin provider from flat Cerebras model IDs.
 *
 * Order matters: put more-specific keywords first so that, e.g.,
 * `deepseek-r1-distill-llama-70b` resolves to "deepseek" rather than "meta".
 */
const ORIGIN_RULES: [string, string][] = [
	["deepseek", "deepseek"],
	["mistral", "mistral"],
	["llama", "meta"],
	["qwen", "qwen"],
];

/**
 * Discovers models available through the Cerebras Inference API.
 *
 * Cerebras serves a small, curated catalog of open-source models on their
 * custom CS-3 silicon. All models are chat/instruct models — no embedding
 * or vision models are currently offered. Every model supports function
 * calling via the OpenAI-compatible tool-use API.
 *
 * Model IDs use flat naming without a vendor prefix (e.g. `llama3.1-8b`),
 * so origin provider is inferred from keywords in the ID.
 */
export class CerebrasDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "cerebras";
	readonly providerName = "Cerebras";
	readonly baseUrl = "https://api.cerebras.ai";

	/**
	 * Keep all models — Cerebras maintains a small curated catalog and every
	 * listed model is a usable chat/instruct model. No filtering needed.
	 */
	protected isRelevantModel(_model: OpenAICompatibleModel): boolean {
		return true;
	}

	/**
	 * Classify a Cerebras model: infer origin from flat ID keywords,
	 * set mode to "chat", and assign standard chat capabilities.
	 *
	 * All models on Cerebras are chat/instruct models with function-calling
	 * support. Origin is inferred by matching keywords in the model ID.
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();
		const originProvider = this.inferOriginFromKeywords(lower, ORIGIN_RULES, "cerebras");

		return {
			originProvider,
			mode: "chat",
			capabilities: ["chat", "function_calling"],
		};
	}
}
