/**
 * kosha-discovery — OpenAI provider discoverer.
 *
 * Queries the OpenAI `/v1/models` endpoint, filters out irrelevant
 * legacy/fine-tuned models, and maps the rest into {@link ModelCard} objects.
 * @module
 */

import type { CredentialResult, ModelCard, ModelMode } from "../types.js";
import { BaseDiscoverer } from "./base.js";
import { getPublicSeed } from "./public-seed.js";
import { STATIC_OPENAI_MODELS } from "./static-direct.js";

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
			return this.publicCatalogFallback();
		}

		const timeoutMs = this.validateTimeout(options?.timeout);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
		};

		const response = await this.fetchJSON<OpenAIListResponse>(`${this.baseUrl}/v1/models`, headers, timeoutMs);

		const apiCards = response.data
			.filter((model) => this.isRelevantModel(model.id))
			.map((model) => this.toModelCard(model));
		// Merge public catalog so models that exist via OpenAI but aren't in
		// /v1/models (preview tiers, deprecated-but-still-priced SKUs) keep
		// their pricing in the registry. API wins on `id` collision.
		return this.mergeWithPublicSeed(apiCards);
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
		if (
			lower.startsWith("babbage") ||
			lower.startsWith("davinci") ||
			lower.startsWith("curie") ||
			lower.startsWith("ada")
		) {
			return false;
		}

		// Keep chat, embedding, image, video, moderation, and audio models
		return (
			this.isChatModel(lower) ||
			this.isEmbeddingModel(lower) ||
			this.isImageModel(lower) ||
			this.isVideoModel(lower) ||
			this.isModerationModel(lower) ||
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
			id.startsWith("chatgpt-") ||
			id.includes("codex") ||
			id.includes("computer-use")
		);
	}

	/** Check if the model ID belongs to the embedding family. */
	private isEmbeddingModel(id: string): boolean {
		return id.includes("embedding");
	}

	/** Check if the model ID belongs to the image generation family (DALL-E / gpt-image). */
	private isImageModel(id: string): boolean {
		return id.includes("dall-e") || id.includes("gpt-image");
	}

	/** Check if the model ID belongs to the video generation family (Sora). */
	private isVideoModel(id: string): boolean {
		return id.includes("sora");
	}

	/** Check if the model ID belongs to the moderation family. */
	private isModerationModel(id: string): boolean {
		return id.includes("moderation");
	}

	/** Check if the model ID belongs to the audio family (Whisper / TTS / Transcribe / Realtime / Audio). */
	private isAudioModel(id: string): boolean {
		return (
			id.includes("whisper") ||
			id.includes("tts") ||
			id.includes("transcribe") ||
			id.includes("realtime") ||
			id.includes("-audio")
		);
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
		if (this.isVideoModel(id)) return "video";
		if (this.isModerationModel(id)) return "moderation";
		if (this.isAudioModel(id)) return "audio";
		return "chat";
	}

	/**
	 * Infer capability flags from the model ID.
	 */
	private inferCapabilities(id: string): string[] {
		if (this.isEmbeddingModel(id)) {
			return ["embedding"];
		}

		if (this.isImageModel(id)) {
			return ["image_generation"];
		}

		if (this.isVideoModel(id)) {
			return ["video_generation"];
		}

		if (this.isModerationModel(id)) {
			return ["moderation"];
		}

		if (this.isAudioModel(id)) {
			if (id.includes("whisper") || id.includes("transcribe")) return ["speech_to_text"];
			if (id.includes("tts")) return ["text_to_speech"];
			return ["chat", "audio"];
		}

		// o1 models remain without function_calling for legacy loop compatibility
		if (id.startsWith("o1")) {
			return ["chat", "code", "nlu", "reasoning"];
		}

		// o3 / o4 reasoning models support tool use as well as reasoning
		if (id.startsWith("o3") || id.startsWith("o4")) {
			return ["chat", "function_calling", "code", "nlu", "reasoning"];
		}

		// GPT-5, GPT-6, Codex, Computer-Use, GPT-4o, and GPT-4 Turbo — vision + tools + code
		if (
			id.startsWith("gpt-5") ||
			id.startsWith("gpt-6") ||
			id.includes("codex") ||
			id.includes("computer-use") ||
			(id.includes("gpt-4o") && !id.includes("gpt-4o-mini")) ||
			id.includes("gpt-4-turbo")
		) {
			return ["chat", "vision", "function_calling", "code", "nlu"];
		}

		// GPT-4o-mini
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

	/**
	 * No-key fallback: source the latest merged public seed for this provider
	 * via {@link getPublicSeed}. That seed may combine multiple public inputs
	 * (for example models.dev, LiteLLM, and promo overrides) using the
	 * priority rules defined in `getPublicSeed()`. Falls back to the curated
	 * static list if the public seed fetch fails or yields no models.
	 */
	private async publicCatalogFallback(): Promise<ModelCard[]> {
		try {
			const seeds = await getPublicSeed(this.providerId);
			if (seeds.length > 0) return seeds;
		} catch {
			/* fall through to static fallback */
		}
		return this.staticFallbackModels();
	}

	/** Return curated fallback models when both API and public catalog are unavailable. */
	private staticFallbackModels(): ModelCard[] {
		return STATIC_OPENAI_MODELS.map((model) =>
			this.makeCard({
				id: model.id,
				name: model.name,
				provider: this.providerId,
				mode: model.mode,
				capabilities: model.capabilities,
				contextWindow: model.contextWindow ?? 0,
				maxOutputTokens: model.maxOutputTokens ?? 0,
				maxInputTokens: model.maxInputTokens,
				source: "manual",
			}),
		);
	}
}
