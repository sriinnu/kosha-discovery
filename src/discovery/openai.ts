/**
 * kosha-discovery — OpenAI provider discoverer.
 *
 * Queries the OpenAI `/v1/models` endpoint, filters out irrelevant
 * legacy/fine-tuned models, and maps the rest into {@link ModelCard} objects.
 * @module
 */

import type { CredentialResult, ModelCard, ModelMode } from "../types.js";
import { BaseDiscoverer } from "./base.js";

/** Shape of a single model object from the OpenAI list endpoint. */
interface OpenAIModel {
	id: string;
	object: string;
	created: number;
	owned_by: string;
}

/** Response shape from `GET /v1/models`. */
interface OpenAIListResponse {
	data: OpenAIModel[];
	object: string;
}

/**
 * Discovers models available through the OpenAI API.
 *
 * The OpenAI list endpoint returns *every* model the key has access to,
 * including deprecated completions models (babbage, davinci, curie, ada)
 * and fine-tune snapshots.  This discoverer filters those out and keeps
 * only chat, embedding, image, and audio models.
 */
export class OpenAIDiscoverer extends BaseDiscoverer {
	readonly providerId = "openai";
	readonly providerName = "OpenAI";
	readonly baseUrl = "https://api.openai.com";

	/**
	 * Fetch the full model list from OpenAI, filter, and normalize.
	 * @param credential - Must contain an `apiKey` or `accessToken`.
	 * @param options    - Optional timeout override (default 10 s).
	 */
	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const apiKey = credential.apiKey ?? credential.accessToken;
		if (!apiKey) {
			return [];
		}

		const timeoutMs = options?.timeout ?? 10_000;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
		};

		const response = await this.fetchJSON<OpenAIListResponse>(`${this.baseUrl}/v1/models`, headers, timeoutMs);

		return response.data
			.filter((model) => this.isRelevantModel(model.id))
			.map((model) => this.toModelCard(model));
	}

	/**
	 * Determine whether a model ID represents a model we want to track.
	 *
	 * We exclude:
	 *  - Fine-tune snapshots (contain "ft:" or ":ft-")
	 *  - Legacy completions-only models (babbage, davinci, curie, ada) which
	 *    lack chat support and clutter results
	 */
	private isRelevantModel(id: string): boolean {
		const lower = id.toLowerCase();

		// Skip fine-tune snapshots — they are user-specific variants
		if (lower.includes("ft:") || lower.includes(":ft-")) {
			return false;
		}

		// Skip legacy completions-era models that predate the chat API
		if (lower.startsWith("babbage") || lower.startsWith("davinci") || lower.startsWith("curie") || lower.startsWith("ada")) {
			return false;
		}

		// Keep chat, embedding, image, and audio models
		return (
			this.isChatModel(lower) ||
			this.isEmbeddingModel(lower) ||
			this.isImageModel(lower) ||
			this.isAudioModel(lower)
		);
	}

	/** Check if the model ID belongs to the chat model family. */
	private isChatModel(id: string): boolean {
		return (
			id.startsWith("gpt-") ||
			id.startsWith("o1") ||
			id.startsWith("o3") ||
			id.startsWith("o4") ||
			id.startsWith("chatgpt-")
		);
	}

	/** Check if the model ID belongs to the embedding family. */
	private isEmbeddingModel(id: string): boolean {
		return id.includes("embedding");
	}

	/** Check if the model ID belongs to the image generation family (DALL-E). */
	private isImageModel(id: string): boolean {
		return id.includes("dall-e");
	}

	/** Check if the model ID belongs to the audio family (Whisper / TTS). */
	private isAudioModel(id: string): boolean {
		return id.includes("whisper") || id.includes("tts");
	}

	/** Convert an OpenAI model object into a normalized {@link ModelCard}. */
	private toModelCard(model: OpenAIModel): ModelCard {
		const id = model.id.toLowerCase();
		const mode = this.inferMode(id);
		const capabilities = this.inferCapabilities(id);

		return this.makeCard({
			id: model.id,
			name: model.id,
			provider: this.providerId,
			mode,
			capabilities,
		});
	}

	/** Map a model ID to its primary {@link ModelMode}. */
	private inferMode(id: string): ModelMode {
		if (this.isEmbeddingModel(id)) return "embedding";
		if (this.isImageModel(id)) return "image";
		if (this.isAudioModel(id)) return "audio";
		return "chat";
	}

	/**
	 * Infer capability flags from the model ID.
	 *
	 * Key design decisions:
	 *  - o-series reasoning models (o1, o3, o4) do NOT get "function_calling"
	 *    because their reasoning loop does not support tool use in the same way.
	 *  - GPT-4o / GPT-4 Turbo get "vision" since they accept image inputs.
	 *  - GPT-4o-mini lacks vision but retains function_calling.
	 */
	private inferCapabilities(id: string): string[] {
		// Embedding models — single capability
		if (this.isEmbeddingModel(id)) {
			return ["embedding"];
		}

		// Image generation models (DALL-E)
		if (this.isImageModel(id)) {
			return ["image_generation"];
		}

		// Audio models — Whisper for STT, TTS for speech synthesis
		if (this.isAudioModel(id)) {
			if (id.includes("whisper")) return ["speech_to_text"];
			if (id.includes("tts")) return ["text_to_speech"];
			return ["audio"];
		}

		// Reasoning models (o1, o3, o4 series) — no function_calling
		// because their chain-of-thought architecture handles tool use differently
		if (id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
			return ["chat", "code", "nlu"];
		}

		// GPT-4o and GPT-4 Turbo — full capabilities including vision
		if (id.includes("gpt-4o") || id.includes("gpt-4-turbo")) {
			return ["chat", "vision", "function_calling", "code", "nlu"];
		}

		// GPT-4o-mini — capable but lacks vision
		if (id.includes("gpt-4o-mini")) {
			return ["chat", "function_calling", "code", "nlu"];
		}

		// GPT-4 (non-turbo, non-4o)
		if (id.startsWith("gpt-4")) {
			return ["chat", "function_calling", "code", "nlu"];
		}

		// GPT-3.5 and other chat models — basic chat with function calling
		if (id.startsWith("gpt-") || id.startsWith("chatgpt-")) {
			return ["chat", "function_calling", "code"];
		}

		return ["chat"];
	}
}
