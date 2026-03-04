/**
 * kosha-discovery — Together AI provider discoverer.
 *
 * Queries the Together AI `/v1/models` endpoint (OpenAI-compatible),
 * filters relevant models, and maps them into {@link ModelCard} objects.
 *
 * Together AI's catalog is multi-vendor, hosting models from meta-llama,
 * mistralai, Qwen, google, deepseek-ai, microsoft, nvidia, databricks,
 * togethercomputer, and others.
 * @module
 */

import type { ModelMode } from "../types.js";
import { OpenAICompatibleDiscoverer, type ModelClassification, type OpenAICompatibleModel } from "./openai-compatible.js";

/**
 * Discovers models available through the Together AI API (api.together.xyz).
 *
 * The Together AI catalog serves models from multiple vendors using an
 * OpenAI-compatible API. Model IDs are namespaced (e.g.
 * `meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo`,
 * `mistralai/Mixtral-8x22B-Instruct-v0.1`), allowing origin provider
 * extraction from the prefix.
 */
export class TogetherDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "together";
	readonly providerName = "Together AI";
	readonly baseUrl = "https://api.together.xyz";

	/**
	 * Determine whether a model ID represents a model we want to track.
	 *
	 * We keep chat/instruct, embedding, code, and vision models and filter out:
	 * - Reward models (used for RLHF, not inference)
	 */
	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		const lower = model.id.toLowerCase();

		// Skip reward models — used for RLHF, not direct inference
		if (this.looksLikeReward(lower)) return false;

		return true;
	}

	/**
	 * Classify a Together AI model: determine origin provider, mode, and capabilities.
	 *
	 * Uses namespaced model IDs (vendor/model-name) to extract origin provider.
	 * Normalizes known prefixes via aliases map.
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const id = model.id;
		const lower = id.toLowerCase();

		// Extract origin from vendor/model-name format with alias normalization
		const aliases: Record<string, string> = {
			"meta-llama": "meta",
			"mistralai": "mistral",
			"deepseek-ai": "deepseek",
			"togethercomputer": "together",
		};
		const originProvider = this.extractPrefixOrigin(id, "together", aliases);

		// Detect mode: use model.type field for embedding, or infer from ID
		let mode: ModelMode = "chat";
		if (model.type === "embedding" || this.looksLikeEmbedding(lower)) {
			mode = "embedding";
		}

		// Build capability flags
		const capabilities: string[] = [];

		if (mode === "embedding") {
			capabilities.push("embedding");
		} else {
			capabilities.push("chat");

			// Add vision capability if detected
			if (this.looksLikeVision(lower)) {
				capabilities.push("vision");
			}

			// Add code capability if detected
			if (this.looksLikeCode(lower)) {
				capabilities.push("code");
			}

			// Add function_calling for instruct/chat models
			if (lower.includes("instruct") || lower.includes("chat")) {
				capabilities.push("function_calling");
			}
		}

		return {
			originProvider,
			mode,
			capabilities,
		};
	}
}
