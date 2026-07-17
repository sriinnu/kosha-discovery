/**
 * kosha-discovery — Anthropic provider discoverer.
 *
 * Queries the Anthropic `/v1/models` endpoint to enumerate all available
 * Claude models and maps them into normalized {@link ModelCard} objects.
 * @module
 */

import type { CredentialResult, ModelCard } from "../types.js";
import { BaseDiscoverer, MAX_MODELS_PER_PROVIDER } from "./base.js";
import { getPublicSeed } from "./public-seed.js";
import { STATIC_ANTHROPIC_MODELS } from "./static-direct.js";

/** Shape of a single model object returned by the Anthropic API. */
interface AnthropicModel {
	id: string;
	display_name: string;
	created_at: string;
	type: string;
}

/** Paginated list response from `GET /v1/models`. */
interface AnthropicListResponse {
	data: AnthropicModel[];
	has_more: boolean;
	first_id: string | null;
	last_id: string | null;
}

/**
 * Discovers models available through the Anthropic API.
 *
 * Authentication is via `x-api-key` header. The endpoint is paginated,
 * so we loop until `has_more` is false.
 */
export class AnthropicDiscoverer extends BaseDiscoverer {
	readonly providerId = "anthropic";
	readonly providerName = "Anthropic";
	readonly baseUrl = "https://api.anthropic.com";

	/**
	 * Fetch all models from the Anthropic API using cursor-based pagination.
	 * @param credential - Must contain an `apiKey` or `accessToken`.
	 * @param options    - Optional timeout override (default 10 s).
	 * @returns Normalized model cards, or an empty array if unauthenticated.
	 */
	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const apiKey = credential.apiKey ?? credential.accessToken;
		if (!apiKey) {
			return this.publicCatalogFallback();
		}

		const timeoutMs = this.validateTimeout(options?.timeout);
		const headers: Record<string, string> = {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		};

		const allModels: AnthropicModel[] = [];
		let url = `${this.baseUrl}/v1/models?limit=100`;

		// Cursor-based pagination: keep fetching pages while `has_more` is true.
		// Each page returns up to 100 models; `last_id` serves as the cursor.
		// Two independent guards bound the loop so a buggy or hostile API that
		// keeps returning `has_more: true` (or a repeating cursor) cannot spin
		// forever: the model-count cap and a hard page-count cap.
		const MAX_PAGES = Math.ceil(MAX_MODELS_PER_PROVIDER / 100) + 1;
		let pages = 0;
		while (url) {
			if (pages >= MAX_PAGES) {
				throw new Error(
					`${this.providerName} pagination exceeded ${MAX_PAGES} pages — refusing to loop further`,
				);
			}
			pages += 1;
			const response = await this.fetchJSON<AnthropicListResponse>(url, headers, timeoutMs);
			allModels.push(...response.data);

			if (allModels.length >= MAX_MODELS_PER_PROVIDER) break;

			if (response.has_more && response.last_id) {
				url = `${this.baseUrl}/v1/models?limit=100&after_id=${encodeURIComponent(response.last_id)}`;
			} else {
				url = "";
			}
		}

		const apiCards = allModels.map((model) => this.toModelCard(model));
		// Merge public catalog (models.dev + LiteLLM) so models the user has
		// access to but Anthropic's /v1/models doesn't currently return (e.g.
		// preview/region-gated/early-access SKUs) still get pricing. API wins
		// on identity; seed wins on pricing where the API stub has none.
		return this.mergeWithPublicSeed(apiCards);
	}

	/**
	 * Convert an Anthropic API model object into a normalized {@link ModelCard}.
	 */
	private toModelCard(model: AnthropicModel): ModelCard {
		const capabilities = this.inferCapabilities(model.id);
		const mode = model.id.toLowerCase().includes("embed") ? ("embedding" as const) : ("chat" as const);

		return this.makeCard({
			id: model.id,
			name: model.display_name || model.id,
			provider: this.providerId,
			mode,
			capabilities,
		});
	}

	/**
	 * Infer capability flags from the model ID string.
	 *
	 * All Claude chat models get "chat", "code", "nlu", and "function_calling".
	 * Vision is added for Claude 3+ models (detected via regex).
	 * @param modelId - The canonical Anthropic model ID.
	 */
	private inferCapabilities(modelId: string): string[] {
		const id = modelId.toLowerCase();

		// Embedding models have a single capability
		if (id.includes("embed")) {
			return ["embedding"];
		}

		// All Claude chat models get base capabilities
		const capabilities = ["chat", "code", "nlu", "function_calling"];

		// Claude 3+ models have multimodal vision support
		if (this.hasVisionSupport(id)) {
			capabilities.push("vision");
		}

		return capabilities;
	}

	/**
	 * Check whether a model ID indicates vision (multimodal) support.
	 *
	 * Every namespaced Claude family (opus/sonnet/haiku) has been multimodal
	 * since Claude 3, so family-first IDs (e.g. `claude-opus-4-8`,
	 * `claude-sonnet-5`, `claude-haiku-4-5-20251001`) are matched
	 * directly. Legacy version-first IDs (`claude-3`, `claude-3-5-haiku`,
	 * `claude-4-6`) are covered by the major-version pattern.
	 *
	 * @param id - Lowercased model ID.
	 * @returns `true` for Claude 3+ and all opus/sonnet/haiku family models.
	 */
	private hasVisionSupport(id: string): boolean {
		// Family-first naming (Claude 4+): the family name follows "claude-"
		// directly (e.g. claude-opus-4-8, claude-sonnet-5). None of
		// these carry a legacy major-version token, so the pattern below would
		// miss them without this check.
		if (/^claude-(opus|sonnet|haiku)/.test(id)) return true;
		// Legacy version-first naming: claude-3, claude-3-5-haiku, claude-4-6.
		// Captures a major version >= 3, covering all current and future
		// multimodal Claude models that still use the version-first shape.
		return /claude-([3-9]|[1-9]\d)/.test(id);
	}

	/**
	 * No-key fallback: source the latest provider catalogue from the public
	 * seed pipeline (`getPublicSeed()`), which can merge models.dev,
	 * LiteLLM, and promotional overrides. Falls back to the curated static
	 * list only if public seed retrieval fails or returns no models.
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
		return STATIC_ANTHROPIC_MODELS.map((model) =>
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
