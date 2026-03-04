/**
 * kosha-discovery — DeepInfra provider discoverer.
 *
 * Queries the DeepInfra `/v1/models` endpoint (OpenAI-compatible),
 * filters relevant models, and maps them into {@link ModelCard} objects.
 *
 * DeepInfra's API catalog is multi-vendor, hosting models from meta, mistral,
 * deepseek, qwen, bigcode, google, and others. Model IDs use `vendor/model-name`
 * namespacing (e.g. `meta-llama/Meta-Llama-3.1-405B-Instruct`).
 * @module
 */

import { OpenAICompatibleDiscoverer, type OpenAICompatibleModel, type ModelClassification } from "./openai-compatible.js";

/**
 * Alias map normalizing DeepInfra vendor prefixes to canonical origin providers.
 *
 * DeepInfra uses prefixes like `meta-llama` (not `meta`) and `mistralai` (not `mistral`),
 * so we remap them to their canonical short forms.
 */
const PREFIX_ALIASES: Record<string, string> = {
	"meta-llama": "meta",
	"mistralai": "mistral",
	"deepseek-ai": "deepseek",
	"bigcode": "mistral",
};

/**
 * Discovers models available through the DeepInfra API (api.deepinfra.com).
 *
 * The DeepInfra catalog serves models from multiple vendors using an
 * OpenAI-compatible API. Model IDs are namespaced (e.g.
 * `meta-llama/Meta-Llama-3.1-405B-Instruct`, `Qwen/Qwen2.5-72B-Instruct`),
 * allowing origin provider extraction from the prefix.
 */
export class DeepInfraDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "deepinfra";
	readonly providerName = "DeepInfra";
	readonly baseUrl = "https://api.deepinfra.com";

	/**
	 * Filter out models that are not suitable for direct inference.
	 *
	 * We exclude:
	 * - Reward models (used for RLHF training pipelines, not inference)
	 */
	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		const lower = model.id.toLowerCase();
		return !this.looksLikeReward(lower);
	}

	/**
	 * Classify a DeepInfra model: extract origin provider, infer mode and capabilities.
	 *
	 * DeepInfra uses `vendor/model-name` namespacing, so we extract the origin
	 * provider from the prefix and apply well-known aliases to normalize names
	 * (e.g. `meta-llama` -> `meta`, `mistralai` -> `mistral`).
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const id = model.id;
		const lower = id.toLowerCase();

		const originProvider = this.extractPrefixOrigin(lower, "deepinfra", PREFIX_ALIASES);

		// Embedding: DeepInfra exposes a type field on some models; also check ID heuristic
		if (this.looksLikeEmbedding(lower) || model.type === "embedding") {
			return {
				originProvider,
				mode: "embedding",
				capabilities: ["embedding"],
			};
		}

		const capabilities: string[] = ["chat"];

		// Vision capability
		if (this.looksLikeVision(lower)) {
			capabilities.push("vision");
		}

		// Code-specialized capability
		if (this.looksLikeCode(lower)) {
			capabilities.push("code");
		}

		// Function calling — instruct and chat models on DeepInfra support tool use
		if (lower.includes("instruct") || lower.includes("chat")) {
			capabilities.push("function_calling");
		}

		return {
			originProvider,
			mode: "chat",
			capabilities,
		};
	}
}
