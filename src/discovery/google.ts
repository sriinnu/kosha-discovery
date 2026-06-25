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
import { BaseDiscoverer, MAX_MODELS_PER_PROVIDER } from "./base.js";
import { getPublicSeed } from "./public-seed.js";
import { STATIC_GOOGLE_MODELS } from "./static-direct.js";

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
			return this.publicCatalogFallback();
		}

		const timeoutMs = this.validateTimeout(options?.timeout);
		const allModels: GoogleModel[] = [];
		let pageToken: string | undefined;

		// Pass the key via the `x-goog-api-key` header rather than a `?key=`
		// query parameter. A key in the URL leaks into proxy access logs, the
		// HTTP Referer, and any place a URL is logged for diagnostics; a header
		// does not. Google accepts both forms for this API.
		const headers: Record<string, string> = { "x-goog-api-key": apiKey };

		// Token-based pagination: keep fetching while a nextPageToken is returned
		do {
			const url = this.buildUrl(pageToken);
			const response = await this.fetchJSON<GoogleListResponse>(url, headers, timeoutMs);
			allModels.push(...response.models);
			pageToken = response.nextPageToken;
			if (allModels.length >= MAX_MODELS_PER_PROVIDER) break;
		} while (pageToken);

		const apiCards = allModels.map((model) => this.toModelCard(model));
		// Merge public catalog so any Gemini SKU not in v1beta/models keeps its
		// pricing. API wins on identity; seed wins on pricing where the API
		// stub has none.
		return this.mergeWithPublicSeed(apiCards);
	}

	/**
	 * Build the paginated list URL with an optional page token. The API key is
	 * sent via the `x-goog-api-key` header (see {@link discover}), never in the
	 * URL, so it cannot leak through logs or referrers.
	 */
	private buildUrl(pageToken?: string): string {
		let url = `${this.baseUrl}/v1beta/models?pageSize=100`;
		if (pageToken) {
			url += `&pageToken=${encodeURIComponent(pageToken)}`;
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

	/**
	 * No-key fallback: source the latest public seed via {@link getPublicSeed},
	 * which uses models.dev as the primary source, fills gaps from the public
	 * LiteLLM catalog, and applies promo overrides. Falls back to the curated
	 * static list only if the public-seed fetch fails or returns no models.
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
		return STATIC_GOOGLE_MODELS.map((model) =>
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
