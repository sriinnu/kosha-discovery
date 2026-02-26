/**
 * kosha-discovery — Google / Gemini provider discoverer.
 *
 * Queries the Google Generative Language API (`/v1beta/models`) to enumerate
 * all Gemini models.  Unlike most providers, this API is "rich" — it returns
 * context window sizes (`inputTokenLimit`, `outputTokenLimit`) and supported
 * generation methods directly, so we can populate those fields without
 * relying on enrichment.
 * @module
 */

import type { CredentialResult, ModelCard, ModelMode } from "../types.js";
import { BaseDiscoverer } from "./base.js";

/** Shape of a single model from the Google Generative Language API. */
interface GoogleModel {
	name: string;
	displayName: string;
	description: string;
	inputTokenLimit: number;
	outputTokenLimit: number;
	supportedGenerationMethods: string[];
	temperature?: number;
	maxTemperature?: number;
	topP?: number;
	topK?: number;
}

/** Paginated list response from the Google models endpoint. */
interface GoogleListResponse {
	models: GoogleModel[];
	nextPageToken?: string;
}

/**
 * Discovers models available through the Google Generative Language API.
 *
 * Authentication is via an API key passed as a query parameter.
 * The endpoint uses token-based pagination (`nextPageToken`).
 */
export class GoogleDiscoverer extends BaseDiscoverer {
	readonly providerId = "google";
	readonly providerName = "Google";
	readonly baseUrl = "https://generativelanguage.googleapis.com";

	/**
	 * Fetch all Gemini models using token-based pagination.
	 * @param credential - Must contain an `apiKey` or `accessToken`.
	 * @param options    - Optional timeout override (default 10 s).
	 */
	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const apiKey = credential.apiKey ?? credential.accessToken;
		if (!apiKey) {
			return [];
		}

		const timeoutMs = options?.timeout ?? 10_000;
		const allModels: GoogleModel[] = [];
		let pageToken: string | undefined;

		// Token-based pagination: keep fetching while a nextPageToken is returned
		do {
			const url = this.buildUrl(apiKey, pageToken);
			const response = await this.fetchJSON<GoogleListResponse>(url, undefined, timeoutMs);
			allModels.push(...response.models);
			pageToken = response.nextPageToken;
		} while (pageToken);

		return allModels.map((model) => this.toModelCard(model));
	}

	/**
	 * Build the paginated list URL with API key and optional page token.
	 */
	private buildUrl(apiKey: string, pageToken?: string): string {
		let url = `${this.baseUrl}/v1beta/models?key=${apiKey}&pageSize=100`;
		if (pageToken) {
			url += `&pageToken=${pageToken}`;
		}
		return url;
	}

	/**
	 * Convert a Google API model object into a normalized {@link ModelCard}.
	 *
	 * The Google API returns model names prefixed with "models/" (e.g.
	 * "models/gemini-2.5-pro"), so we strip that prefix to get the bare ID.
	 */
	private toModelCard(model: GoogleModel): ModelCard {
		// Strip the "models/" prefix that Google prepends to every model name
		const id = model.name.startsWith("models/") ? model.name.slice(7) : model.name;
		const mode = this.inferMode(model);
		const capabilities = this.inferCapabilities(model);

		return this.makeCard({
			id,
			name: model.displayName || id,
			provider: this.providerId,
			mode,
			capabilities,
			// Google's API is "rich" — it gives us context windows directly
			contextWindow: model.inputTokenLimit ?? 0,
			maxOutputTokens: model.outputTokenLimit ?? 0,
			maxInputTokens: model.inputTokenLimit ?? undefined,
		});
	}

	/**
	 * Determine the primary {@link ModelMode} from the model's generation methods.
	 */
	private inferMode(model: GoogleModel): ModelMode {
		const methods = model.supportedGenerationMethods ?? [];
		const displayLower = (model.displayName ?? "").toLowerCase();

		// Embedding models expose the "embedContent" generation method
		if (methods.includes("embedContent") || displayLower.includes("embedding")) {
			return "embedding";
		}

		return "chat";
	}

	/**
	 * Infer capability flags from the model's metadata and ID.
	 *
	 * Gemini Pro, Ultra, and Flash variants support function calling and vision.
	 */
	private inferCapabilities(model: GoogleModel): string[] {
		const methods = model.supportedGenerationMethods ?? [];
		const displayLower = (model.displayName ?? "").toLowerCase();
		const capabilities: string[] = [];

		if (methods.includes("embedContent") || displayLower.includes("embedding")) {
			return ["embedding"];
		}

		if (methods.includes("generateContent")) {
			capabilities.push("chat");
		}

		// Gemini models generally support code and NLU
		const id = model.name.toLowerCase();
		if (id.includes("gemini")) {
			capabilities.push("code", "nlu");

			// Pro, Ultra, and Flash variants support function calling
			if (id.includes("pro") || id.includes("ultra") || id.includes("flash")) {
				capabilities.push("function_calling");
			}

			// These same variants also support multimodal vision input
			if (id.includes("pro") || id.includes("ultra") || id.includes("flash")) {
				capabilities.push("vision");
			}
		}

		return capabilities.length > 0 ? capabilities : ["chat"];
	}
}
