/**
 * kosha-discovery — OpenRouter aggregator discoverer.
 *
 * OpenRouter is a unified gateway that proxies requests to many upstream
 * providers (OpenAI, Anthropic, Google, Meta, Mistral, etc.).  Its model
 * list endpoint returns rich metadata including pricing, context lengths,
 * and architecture info — making it one of the most informative sources.
 * @module
 */

import type { CredentialResult, ModelCard, ModelMode, ModelPricing } from "../types.js";
import { BaseDiscoverer } from "./base.js";

/** Per-token pricing strings returned by OpenRouter (values are stringified floats). */
interface OpenRouterPricing {
	prompt: string;
	completion: string;
	image?: string;
	request?: string;
}

/** Architecture / modality metadata for an OpenRouter model. */
interface OpenRouterArchitecture {
	modality: string;
	tokenizer: string;
	instruct_type: string | null;
}

/** Top-provider info including output token limits. */
interface OpenRouterTopProvider {
	max_completion_tokens: number | null;
	is_moderated: boolean;
}

/** Shape of a single model in the OpenRouter list response. */
interface OpenRouterModel {
	id: string;
	name: string;
	description: string;
	pricing: OpenRouterPricing;
	context_length: number;
	top_provider: OpenRouterTopProvider;
	architecture: OpenRouterArchitecture;
	per_request_limits?: Record<string, string> | null;
}

/** Response shape from `GET /api/v1/models`. */
interface OpenRouterListResponse {
	data: OpenRouterModel[];
}

/**
 * Discovers models available through the OpenRouter aggregator.
 *
 * OpenRouter acts as a single gateway to dozens of providers.  Its model
 * list is publicly accessible (no API key required), though an
 * authenticated request gets higher rate limits.
 */
export class OpenRouterDiscoverer extends BaseDiscoverer {
	readonly providerId = "openrouter";
	readonly providerName = "OpenRouter";
	readonly baseUrl = "https://openrouter.ai";

	/**
	 * Fetch the full model catalogue from OpenRouter.
	 *
	 * @param credential - API key is **optional** for this provider.
	 *                     The endpoint works without auth, just with stricter rate limits.
	 * @param options    - Optional timeout override (default 15 s — larger because the
	 *                     response contains hundreds of models).
	 */
	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const timeoutMs = options?.timeout ?? 15_000;
		const headers: Record<string, string> = {};

		// API key is optional — the /api/v1/models endpoint is publicly
		// accessible; auth only provides higher rate limits
		const apiKey = credential.apiKey ?? credential.accessToken;
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const response = await this.fetchJSON<OpenRouterListResponse>(
			`${this.baseUrl}/api/v1/models`,
			Object.keys(headers).length > 0 ? headers : undefined,
			timeoutMs,
		);

		return response.data
			.filter((model) => this.isAvailable(model))
			.map((model) => this.toModelCard(model));
	}

	/**
	 * Filter out unavailable models. OpenRouter marks delisted models
	 * with `pricing.prompt === "-1"`.
	 */
	private isAvailable(model: OpenRouterModel): boolean {
		return model.pricing?.prompt !== "-1";
	}

	/** Convert an OpenRouter model object into a normalized {@link ModelCard}. */
	private toModelCard(model: OpenRouterModel): ModelCard {
		const mode = this.inferMode(model);
		const capabilities = this.inferCapabilities(model);
		const pricing = this.parsePricing(model.pricing);
		const originProvider = this.extractOriginProvider(model.id);

		return this.makeCard({
			id: model.id,
			name: model.name || model.id,
			provider: this.providerId,
			originProvider,
			mode,
			capabilities,
			contextWindow: model.context_length ?? 0,
			maxOutputTokens: model.top_provider?.max_completion_tokens ?? 0,
			pricing,
		});
	}

	/**
	 * Extract the canonical origin-provider slug from an OpenRouter compound
	 * model ID of the form `{vendor}/{model-name}`.
	 *
	 * OpenRouter uses vendor-namespaced IDs (e.g. `anthropic/claude-opus-4-6`,
	 * `meta-llama/llama-3-70b`).  We take the prefix before the first `/` and
	 * normalise it to our canonical slug so that downstream consumers can group
	 * models by original creator regardless of which gateway serves them.
	 *
	 * @param modelId - Raw OpenRouter model ID.
	 * @returns Canonical provider slug (e.g. `"anthropic"`, `"meta"`, `"openai"`).
	 */
	private extractOriginProvider(modelId: string): string {
		const slashIndex = modelId.indexOf("/");
		if (slashIndex === -1) {
			// No vendor prefix — treat the whole ID as the slug
			return modelId;
		}

		const prefix = modelId.slice(0, slashIndex);

		// Map well-known OpenRouter vendor prefixes to canonical slugs.
		// Unknown prefixes fall through and are returned as-is.
		const vendorMap: Record<string, string> = {
			anthropic: "anthropic",
			openai: "openai",
			google: "google",
			"meta-llama": "meta",
			mistralai: "mistral",
			cohere: "cohere",
			deepseek: "deepseek",
			qwen: "qwen",
		};

		return vendorMap[prefix] ?? prefix;
	}

	/** Infer the primary {@link ModelMode} from modality and naming patterns. */
	private inferMode(model: OpenRouterModel): ModelMode {
		const modality = (model.architecture?.modality ?? "").toLowerCase();
		const id = model.id.toLowerCase();
		const name = (model.name ?? "").toLowerCase();

		if (modality.includes("image") && !modality.includes("text")) {
			return "image";
		}
		if (modality.includes("audio")) {
			return "audio";
		}
		if (id.includes("embed") || name.includes("embedding")) {
			return "embedding";
		}

		return "chat";
	}

	/**
	 * Infer capability flags from architecture modality and model ID.
	 */
	private inferCapabilities(model: OpenRouterModel): string[] {
		const modality = (model.architecture?.modality ?? "").toLowerCase();
		const id = model.id.toLowerCase();
		const capabilities: string[] = [];

		if (id.includes("embed")) {
			return ["embedding"];
		}

		// Image-generation-only models should advertise image capability.
		if (modality.includes("image") && !modality.includes("text")) {
			return ["image_generation"];
		}

		capabilities.push("chat");

		// Vision from modality: "text+image" means multimodal input
		if (modality.includes("image") && modality.includes("text")) {
			capabilities.push("vision");
		}

		// Heuristic: well-known modern chat models support tool use and code
		if (this.isModernChatModel(id)) {
			capabilities.push("function_calling", "code", "nlu");
		}

		return capabilities;
	}

	/**
	 * Heuristic to identify "modern chat models" that support structured
	 * tool use (function calling), code generation, and NLU.
	 *
	 * We match on known provider/model family prefixes. This is intentionally
	 * broad — false positives are benign (extra capability flags), while false
	 * negatives would hide useful features.
	 */
	private isModernChatModel(id: string): boolean {
		return (
			id.includes("gpt-4") ||
			id.includes("claude-3") ||
			id.includes("claude-sonnet") ||
			id.includes("claude-opus") ||
			id.includes("gemini") ||
			id.includes("command-r") ||
			id.includes("mistral-large") ||
			id.includes("llama-3") ||
			id.includes("deepseek")
		);
	}

	/**
	 * Parse OpenRouter's per-token pricing into our per-million format.
	 *
	 * OpenRouter returns pricing as **cost per single token** (stringified
	 * floats).  We multiply by 1,000,000 to convert to our standard
	 * per-million-token pricing representation.
	 */
	private parsePricing(pricing: OpenRouterPricing | undefined): ModelPricing | undefined {
		if (!pricing) return undefined;

		const promptCost = Number.parseFloat(pricing.prompt);
		const completionCost = Number.parseFloat(pricing.completion);

		if (Number.isNaN(promptCost) || Number.isNaN(completionCost)) {
			return undefined;
		}

		return {
			// Convert per-token cost to per-million-token cost
			inputPerMillion: promptCost * 1_000_000,
			outputPerMillion: completionCost * 1_000_000,
		};
	}
}
