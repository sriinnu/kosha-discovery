/**
 * kosha-discovery — Cohere provider discoverer.
 *
 * Queries the Cohere OpenAI-compatible `/v1/models` endpoint,
 * maps each model into a normalized {@link ModelCard}, and classifies
 * the full catalog — chat, embedding, and rerank models alike.
 *
 * Auth: `Authorization: Bearer $CO_API_KEY`
 * @module
 */

import type { ModelMode } from "../types.js";
import { OpenAICompatibleDiscoverer, type ModelClassification, type OpenAICompatibleModel } from "./openai-compatible.js";

/**
 * Discovers models available through the Cohere API.
 *
 * Cohere exposes an OpenAI-compatible `/v1/models` endpoint at
 * `https://api.cohere.com/compatibility`. All models in the catalog
 * are Cohere's own, so `originProvider` is always `"cohere"`.
 *
 * Model families:
 * - **command-r-plus / command-r** — flagship chat models with NLU capabilities
 * - **command-light** — lighter chat model
 * - **embed-*** — text embedding models
 * - **rerank-*** — reranking models (classified as embedding mode)
 */
export class CohereDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "cohere";
	readonly providerName = "Cohere";
	readonly baseUrl = "https://api.cohere.com/compatibility";

	/**
	 * Keep all models in the Cohere catalog.
	 *
	 * Cohere maintains a clean, intentional catalog (no reward models,
	 * no internal snapshots), so no filtering is required.
	 */
	protected isRelevantModel(_model: OpenAICompatibleModel): boolean {
		return true;
	}

	/**
	 * Classify a Cohere model: all are first-party, with mode and
	 * capabilities inferred from the model ID.
	 *
	 * Rules:
	 * - `originProvider` is always `"cohere"`
	 * - Embedding/rerank models → mode `"embedding"`, caps `["embedding"]`
	 * - All chat models → caps include `"function_calling"` (Cohere supports tool use)
	 * - `command-r-plus` and `command-r` additionally get `"nlu"`
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();
		const mode = this.inferMode(lower);
		const capabilities = this.inferCapabilities(lower);

		return {
			originProvider: "cohere",
			mode,
			capabilities,
		};
	}

	/** Map a model ID to its primary {@link ModelMode}. */
	private inferMode(lower: string): ModelMode {
		if (this.looksLikeEmbedding(lower)) return "embedding";
		return "chat";
	}

	/**
	 * Infer capability flags from the lowercase model ID.
	 *
	 * - Embedding/rerank → `["embedding"]`
	 * - All chat models  → `["chat", "function_calling"]` (+ `"nlu"` for command-r variants)
	 */
	private inferCapabilities(lower: string): string[] {
		if (this.looksLikeEmbedding(lower)) {
			return ["embedding"];
		}

		const caps: string[] = ["chat", "function_calling"];

		// command-r-plus and command-r have advanced NLU/RAG capabilities
		if (lower === "command-r-plus" || lower === "command-r") {
			caps.push("nlu");
		}

		return caps;
	}
}
