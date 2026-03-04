/**
 * kosha-discovery — OpenAI-compatible provider base class.
 *
 * Many providers (NVIDIA, Together AI, Fireworks AI, Groq, Mistral AI,
 * DeepInfra, Cerebras, Perplexity, etc.) expose an OpenAI-compatible
 * `/v1/models` endpoint with Bearer auth. This base class extracts the
 * shared discover/filter/map pipeline so concrete providers only need to
 * define identity fields and override the three hooks:
 *
 *   - {@link isRelevantModel} — filter out irrelevant models
 *   - {@link classifyModel}   — determine origin, mode, and capabilities
 *
 * @module
 */

import type { CredentialResult, ModelCard, ModelMode } from "../types.js";
import { BaseDiscoverer } from "./base.js";

/** Shape of a single model from any OpenAI-compatible `/v1/models` response. */
export interface OpenAICompatibleModel {
	id: string;
	object: string;
	created: number;
	owned_by: string;
	/** Some providers (Together AI) include a type field. */
	type?: string;
	/** Some providers (Groq) include a context_window field. */
	context_window?: number;
}

/** Standard response shape from `GET /v1/models`. */
export interface OpenAICompatibleListResponse {
	data: OpenAICompatibleModel[];
	object: string;
}

/** Classification result returned by the per-provider hook. */
export interface ModelClassification {
	originProvider: string;
	mode: ModelMode;
	capabilities: string[];
	contextWindow?: number;
}

/**
 * Base class for providers that expose an OpenAI-compatible `/v1/models` endpoint.
 *
 * Concrete subclasses set `providerId`, `providerName`, `baseUrl` and override:
 *
 * - {@link isRelevantModel} — Return false to filter a model out.
 * - {@link classifyModel} — Return origin, mode, and capabilities.
 *
 * The `discover()` pipeline handles auth, fetch, filter, and card construction.
 *
 * @example
 * export class MyProviderDiscoverer extends OpenAICompatibleDiscoverer {
 *   readonly providerId = "myprovider";
 *   readonly providerName = "My Provider";
 *   readonly baseUrl = "https://api.myprovider.com";
 *
 *   protected isRelevantModel(model: OpenAICompatibleModel): boolean { ... }
 *   protected classifyModel(model: OpenAICompatibleModel): ModelClassification { ... }
 * }
 */
export abstract class OpenAICompatibleDiscoverer extends BaseDiscoverer {
	/**
	 * Fetch the model list, filter, classify, and return normalized cards.
	 *
	 * @param credential - Must contain `apiKey` or `accessToken`.
	 * @param options    - Optional timeout override (default 10 s).
	 */
	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const apiKey = credential.apiKey ?? credential.accessToken;
		if (!apiKey) {
			return [];
		}

		const timeoutMs = this.validateTimeout(options?.timeout);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
		};

		const response = await this.fetchJSON<OpenAICompatibleListResponse>(
			`${this.baseUrl}/v1/models`,
			headers,
			timeoutMs,
		);

		return response.data
			.filter((model) => this.isRelevantModel(model))
			.map((model) => this.toCard(model));
	}

	/**
	 * Return false to exclude a model from discovery results.
	 *
	 * Default implementation keeps all models. Override to filter
	 * reward models, fine-tune snapshots, deprecated entries, etc.
	 */
	protected isRelevantModel(_model: OpenAICompatibleModel): boolean {
		return true;
	}

	/**
	 * Classify a model: determine origin provider, mode, and capabilities.
	 *
	 * Must be implemented by each concrete subclass since classification
	 * rules are provider-specific.
	 */
	protected abstract classifyModel(model: OpenAICompatibleModel): ModelClassification;

	// ---------------------------------------------------------------------------
	// Shared classification helpers — subclasses can call these for common logic
	// ---------------------------------------------------------------------------

	/**
	 * Extract origin provider from a `vendor/model-name` namespaced ID.
	 * Returns `fallback` if no `/` is present.
	 */
	protected extractPrefixOrigin(id: string, fallback: string, aliases?: Record<string, string>): string {
		const slashIdx = id.indexOf("/");
		if (slashIdx === -1) return fallback;

		const prefix = id.slice(0, slashIdx).toLowerCase();
		if (aliases && prefix in aliases) return aliases[prefix];
		return prefix;
	}

	/**
	 * Infer origin from flat model ID keywords (for providers like Groq
	 * that don't use namespaced IDs).
	 *
	 * Checks keywords in order — put more-specific matches first
	 * (e.g. "deepseek" before "llama" for `deepseek-r1-distill-llama-70b`).
	 */
	protected inferOriginFromKeywords(lower: string, rules: [string, string][], fallback: string): string {
		for (const [keyword, origin] of rules) {
			if (lower.includes(keyword)) return origin;
		}
		return fallback;
	}

	/** Check if a lowercase model ID looks like an embedding model. */
	protected looksLikeEmbedding(lower: string): boolean {
		return lower.includes("embed") || lower.includes("rerank");
	}

	/** Check if a lowercase model ID looks like a vision model. */
	protected looksLikeVision(lower: string): boolean {
		return lower.includes("vision") || lower.includes("vlm") || lower.includes("llava") ||
			lower.includes("pixtral") || lower.includes("neva") || lower.includes("fuyu") ||
			lower.includes("cogvlm") || lower.includes("vila");
	}

	/** Check if a lowercase model ID looks like a code model. */
	protected looksLikeCode(lower: string): boolean {
		return lower.includes("code") || lower.includes("codestral") ||
			lower.includes("starcoder") || lower.includes("codellama") || lower.includes("coder");
	}

	/** Check if a lowercase model ID looks like an audio/speech model. */
	protected looksLikeAudio(lower: string): boolean {
		return lower.includes("whisper") || lower.includes("tts");
	}

	/** Check if ID contains common "reward model" patterns to filter. */
	protected looksLikeReward(lower: string): boolean {
		return lower.includes("reward");
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	/** Build a ModelCard from a raw API model + classification. */
	private toCard(model: OpenAICompatibleModel): ModelCard {
		const classification = this.classifyModel(model);
		return this.makeCard({
			id: model.id,
			name: model.id,
			provider: this.providerId,
			originProvider: classification.originProvider,
			mode: classification.mode,
			capabilities: classification.capabilities,
			contextWindow: classification.contextWindow ?? model.context_window ?? 0,
		});
	}
}
