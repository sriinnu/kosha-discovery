/**
 * kosha-discovery — OpenRouter aggregator discoverer.
 *
 * OpenRouter is a unified gateway that proxies requests to many upstream
 * providers (OpenAI, Anthropic, Google, Meta, Mistral, etc.).  Its model
 * list endpoint returns rich metadata including pricing, context lengths,
 * and architecture info — making it one of the most informative sources.
 * @module
 */

import type { CredentialResult, ModelCard, ModelMode, ModelPricing, ModelStatus } from "../types.js";
import { BaseDiscoverer } from "./base.js";
// Route origin-provider derivation through the canonical normalizer so the
// vendor→origin mapping lives in one place instead of being re-maintained here.
import { extractOriginProvider as extractCanonicalOriginProvider } from "../normalize.js";

/** Per-token pricing strings returned by OpenRouter (values are stringified floats). */
interface OpenRouterPricing {
	prompt: string;
	completion: string;
	image?: string;
	request?: string;
	/** Per-token cost for reading a cached prompt (Anthropic-style prompt caching). */
	input_cache_read?: string;
	/** Per-token cost for writing a prompt to the cache. */
	input_cache_write?: string;
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
	/**
	 * Deprecation date for the model endpoint (`null` when not deprecated).
	 * OpenRouter surfaces a single lifecycle signal — an ISO date string here
	 * means the model is sunsetting on that date. Mapped onto
	 * {@link ModelCard.deprecationDate} / {@link ModelCard.status}.
	 */
	expiration_date?: string | null;
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
		const timeoutMs = this.validateTimeout(options?.timeout, 15_000);
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
		const lifecycle = this.inferLifecycleStatus(model.expiration_date);

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
			// Lifecycle fields are populated only when OpenRouter signals a
			// sunset; normal models stay undefined (treated as active by
			// downstream consumers) so later enrichers can still upgrade them.
			status: lifecycle.status,
			deprecationDate: lifecycle.deprecationDate,
		});
	}

	/**
	 * Extract the canonical origin-provider slug from an OpenRouter compound
	 * model ID of the form `{vendor}/{model-name}`.
	 *
	 * Delegates to the shared normalizer (`extractOriginProvider` in
	 * `src/normalize.ts`) so the vendor→origin mapping lives in one place
	 * rather than being re-maintained per discoverer. OpenRouter IDs are
	 * always vendor-namespaced; when the canonical helper doesn't recognise
	 * the vendor we fall back to the raw prefix (e.g. `"stabilityai"`,
	 * `"nvidia"`) rather than collapsing to the serving provider, because
	 * the prefix still identifies the original creator.
	 *
	 * @param modelId - Raw OpenRouter model ID.
	 * @returns Canonical provider slug (e.g. `"anthropic"`, `"meta"`, `"openai"`),
	 *          or the raw vendor prefix when the creator is unknown.
	 */
	private extractOriginProvider(modelId: string): string {
		const canonical = extractCanonicalOriginProvider(modelId);
		if (canonical) return canonical;

		const slashIndex = modelId.indexOf("/");
		if (slashIndex === -1) {
			// No vendor prefix — treat the whole ID as the slug
			return modelId;
		}

		// Unknown vendor namespace — return the raw prefix as-is so we still
		// group by original creator instead of flattening to "openrouter".
		return modelId.slice(0, slashIndex);
	}

	/**
	 * Derive lifecycle status and deprecation date from OpenRouter's
	 * `expiration_date` signal.
	 *
	 * OpenRouter surfaces a single sunset signal per model: `expiration_date`
	 * — an ISO date string (or `null`) describing when the endpoint goes away.
	 * We map it conservatively, mirroring the convention used by the litellm
	 * enricher's `inferStatus`:
	 *  - date in the future → `"deprecated"` (still served, plan migration)
	 *  - date in the past    → `"retired"` (sunset has passed)
	 *  - `null` / absent     → no status (treated as active downstream)
	 *
	 * OpenRouter does not publish a successor model, so `replacedBy` is left
	 * untouched here.
	 *
	 * @param expirationDate - Raw `expiration_date` from the OpenRouter payload.
	 * @returns Partial lifecycle fields to merge into the {@link ModelCard};
	 *          keys are omitted entirely when no signal is present.
	 */
	private inferLifecycleStatus(
		expirationDate: string | null | undefined,
	): { status?: ModelStatus; deprecationDate?: string } {
		if (!expirationDate) return {};

		const ts = Date.parse(expirationDate);
		if (Number.isNaN(ts)) {
			// Present but unparseable — record the raw date but leave status
			// undefined so a downstream enricher can still upgrade it.
			return { deprecationDate: expirationDate };
		}

		return {
			deprecationDate: expirationDate,
			status: ts <= Date.now() ? "retired" : "deprecated",
		};
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

		// I parse cache pricing optionally because most providers don't expose it.
		// Anthropic models (and a growing list of others) support prompt caching
		// and OpenRouter forwards the rates as `input_cache_read` / `input_cache_write`.
		// Both are stringified per-token costs that need the same /1e6 conversion.
		const result: ModelPricing = {
			// Convert per-token cost to per-million-token cost
			inputPerMillion: promptCost * 1_000_000,
			outputPerMillion: completionCost * 1_000_000,
		};

		const cacheReadCost = pricing.input_cache_read !== undefined
			? Number.parseFloat(pricing.input_cache_read)
			: NaN;
		if (Number.isFinite(cacheReadCost)) {
			result.cacheReadPerMillion = cacheReadCost * 1_000_000;
		}

		const cacheWriteCost = pricing.input_cache_write !== undefined
			? Number.parseFloat(pricing.input_cache_write)
			: NaN;
		if (Number.isFinite(cacheWriteCost)) {
			result.cacheWritePerMillion = cacheWriteCost * 1_000_000;
		}

		return result;
	}
}
