/**
 * kosha-discovery — Anthropic provider discoverer.
 *
 * Queries the Anthropic `/v1/models` endpoint to enumerate all available
 * Claude models and maps them into normalized {@link ModelCard} objects.
 * @module
 */

import type { CredentialResult, ModelCard } from "../types.js";
import { BaseDiscoverer } from "./base.js";

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
			return [];
		}

		const timeoutMs = options?.timeout ?? 10_000;
		const headers: Record<string, string> = {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		};

		const allModels: AnthropicModel[] = [];
		let url = `${this.baseUrl}/v1/models?limit=100`;

		// Cursor-based pagination: keep fetching pages while `has_more` is true.
		// Each page returns up to 100 models; `last_id` serves as the cursor.
		while (url) {
			const response = await this.fetchJSON<AnthropicListResponse>(url, headers, timeoutMs);
			allModels.push(...response.data);

			if (response.has_more && response.last_id) {
				url = `${this.baseUrl}/v1/models?limit=100&after_id=${response.last_id}`;
			} else {
				url = "";
			}
		}

		return allModels.map((model) => this.toModelCard(model));
	}

	/**
	 * Convert an Anthropic API model object into a normalized {@link ModelCard}.
	 */
	private toModelCard(model: AnthropicModel): ModelCard {
		const capabilities = this.inferCapabilities(model.id);
		const mode = model.id.toLowerCase().includes("embed") ? "embedding" as const : "chat" as const;

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
	 * @param id - Lowercased model ID.
	 * @returns `true` for Claude 3, 3.5, 4, 4.5, 4.6, etc.
	 */
	private hasVisionSupport(id: string): boolean {
		// Matches "claude-3", "claude-4", "claude-4-6", etc.
		// The regex captures a major version >= 3, covering all current and future multimodal Claude models.
		const visionPattern = /claude-([3-9]|[1-9]\d)/;
		return visionPattern.test(id);
	}
}
