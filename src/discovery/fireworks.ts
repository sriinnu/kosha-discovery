/**
 * kosha-discovery — Fireworks AI provider discoverer.
 *
 * Queries the Fireworks AI `api.fireworks.ai/inference` `/v1/models` endpoint
 * (OpenAI-compatible), filters relevant models, and maps them into
 * {@link ModelCard} objects.
 *
 * Fireworks hosts models from multiple origins (meta, mistral, qwen, google,
 * deepseek, microsoft, and others) under a flat
 * `accounts/fireworks/models/<name>` namespace. Origin is inferred from the
 * model name portion of the ID.
 * @module
 */

import {
	OpenAICompatibleDiscoverer,
	type OpenAICompatibleModel,
	type ModelClassification,
} from "./openai-compatible.js";

/**
 * Discovers models available through the Fireworks AI API.
 *
 * The Fireworks catalog serves models from multiple vendors using an
 * OpenAI-compatible API. Model IDs use the flat
 * `accounts/fireworks/models/<name>` format; origin provider is inferred
 * from keywords in the model name portion.
 */
export class FireworksDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "fireworks";
	readonly providerName = "Fireworks AI";
	readonly baseUrl = "https://api.fireworks.ai/inference";

	/**
	 * Determine whether a model ID represents a model we want to track.
	 *
	 * Fireworks already curates their catalog, so we keep all models except:
	 * - Reward models (used for RLHF, not direct inference)
	 */
	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		const lower = model.id.toLowerCase();

		// Skip reward models — used for RLHF, not direct inference
		if (this.looksLikeReward(lower)) return false;

		return true;
	}

	/**
	 * Classify a Fireworks model: determine origin provider, mode, and capabilities.
	 *
	 * Fireworks model IDs use the `accounts/fireworks/models/<name>` format.
	 * The model name portion after the last `/` is inspected for known
	 * keyword patterns to determine the originating vendor.
	 *
	 * @example
	 * classifyModel("accounts/fireworks/models/llama-v3p1-405b-instruct") // origin: "meta"
	 * classifyModel("accounts/fireworks/models/mixtral-8x22b-instruct")   // origin: "mistral"
	 * classifyModel("accounts/fireworks/models/qwen2p5-72b-instruct")     // origin: "qwen"
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const id = model.id;
		const lower = id.toLowerCase();

		// Extract the model name portion (everything after the last '/')
		const lastSlash = id.lastIndexOf("/");
		const modelName = lastSlash === -1 ? id : id.slice(lastSlash + 1);
		const modelNameLower = modelName.toLowerCase();

		// Determine origin provider from keywords in the model name
		const originProvider = this.inferOriginFromKeywords(
			modelNameLower,
			[
				["llama", "meta"],
				["mixtral", "mistral"],
				["mistral", "mistral"],
				["starcoder", "mistral"],
				["codestral", "mistral"],
				["qwen", "qwen"],
				["gemma", "google"],
				["deepseek", "deepseek"],
				["phi", "microsoft"],
			],
			"fireworks",
		);

		// Determine mode based on model type
		const mode = lower.includes("embed") ? "embedding" : "chat";

		// Infer capabilities from model name
		const capabilities: string[] = [];

		if (lower.includes("embed")) {
			capabilities.push("embedding");
		} else {
			// Non-embedding models default to chat
			capabilities.push("chat");

			// Vision models
			if (this.looksLikeVision(lower)) {
				capabilities.push("vision");
			}

			// Code-specialized models
			if (this.looksLikeCode(lower)) {
				capabilities.push("code");
			}

			// Function calling — instruct/chat models support it
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
