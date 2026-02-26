/**
 * kosha-discovery — LiteLLM community data enrichment.
 *
 * Fetches the community-maintained litellm model catalogue from GitHub
 * and uses it to fill in pricing, context window sizes, and capability
 * flags on already-discovered {@link ModelCard} objects.
 * @module
 */

import type { Enricher, ModelCard, ModelMode, ModelPricing } from "../types.js";
import { normalizeModelId } from "../normalize.js";

/** Shape of a single entry in the litellm pricing JSON. */
interface LiteLLMModelEntry {
	max_tokens?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	cache_read_input_token_cost?: number;
	cache_creation_input_token_cost?: number;
	litellm_provider?: string;
	mode?: string;
	supports_function_calling?: boolean;
	supports_vision?: boolean;
	supports_prompt_caching?: boolean;
	output_vector_size?: number;
}

/**
 * Multiplier to convert litellm's per-token costs into our standard
 * per-million-token pricing.  litellm stores costs as cost-per-single-token,
 * so we multiply by 1 000 000 to get the per-million figure.
 */
const PER_MILLION = 1_000_000;

/**
 * Enriches ModelCard data with pricing, context-window sizes, and capability
 * flags sourced from the litellm community-maintained model catalogue.
 *
 * @see https://github.com/BerriAI/litellm
 */
export class LiteLLMEnricher implements Enricher {
	private data: Record<string, LiteLLMModelEntry> | null = null;
	private readonly url =
		"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

	/** Fetch and cache the litellm pricing JSON. Safe to call multiple times. */
	async load(): Promise<void> {
		if (this.data) return;

		const response = await fetch(this.url);
		if (!response.ok) {
			throw new Error(`Failed to fetch litellm data: ${response.status} ${response.statusText}`);
		}
		this.data = (await response.json()) as Record<string, LiteLLMModelEntry>;
	}

	/**
	 * Enrich an array of ModelCards with litellm data.
	 *
	 * - Only fills in **missing** fields — never overwrites API-sourced data.
	 * - Returns new ModelCard objects (immutable pattern).
	 * - Models not found in litellm are returned unchanged.
	 */
	async enrich(models: ModelCard[]): Promise<ModelCard[]> {
		await this.load();
		return models.map((model) => this.enrichOne(model));
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private enrichOne(model: ModelCard): ModelCard {
		const entry = this.lookupModel(model);
		if (!entry) return { ...model };

		const enriched: ModelCard = { ...model };

		// Pricing — only when the model has no pricing yet
		if (!enriched.pricing) {
			const pricing = this.extractPricing(entry);
			if (pricing) {
				enriched.pricing = pricing;
			}
		}

		// Context window — only when unset (0)
		if (enriched.contextWindow === 0 && entry.max_input_tokens) {
			enriched.contextWindow = entry.max_input_tokens;
		}

		// Max output tokens — only when unset (0)
		if (enriched.maxOutputTokens === 0) {
			if (entry.max_output_tokens) {
				enriched.maxOutputTokens = entry.max_output_tokens;
			} else if (entry.max_tokens) {
				enriched.maxOutputTokens = entry.max_tokens;
			}
		}

		// Max input tokens — only when missing
		if (enriched.maxInputTokens === undefined && entry.max_input_tokens) {
			enriched.maxInputTokens = entry.max_input_tokens;
		}

		// Embedding dimensions — only when missing
		if (enriched.dimensions === undefined && entry.output_vector_size) {
			enriched.dimensions = entry.output_vector_size;
		}

		// Mode — only when we have litellm mode info and the current mode might be wrong
		if (entry.mode) {
			const litellmMode = this.mapMode(entry.mode);
			if (litellmMode && enriched.mode !== litellmMode) {
				// Only override if the model currently has a generic "chat" mode
				// and litellm has more specific info (e.g. "embedding")
				if (enriched.mode === "chat" && litellmMode !== "chat") {
					enriched.mode = litellmMode;
				}
			}
		}

		// Capabilities — add missing ones from litellm flags
		enriched.capabilities = [...enriched.capabilities];
		if (entry.supports_vision && !enriched.capabilities.includes("vision")) {
			enriched.capabilities.push("vision");
		}
		if (entry.supports_function_calling && !enriched.capabilities.includes("function_calling")) {
			enriched.capabilities.push("function_calling");
		}
		if (entry.supports_prompt_caching && !enriched.capabilities.includes("prompt_caching")) {
			enriched.capabilities.push("prompt_caching");
		}

		return enriched;
	}

	/**
	 * Look up a model in the litellm pricing catalogue using a tiered set of
	 * key strategies. Later strategies use `originProvider` to handle models
	 * whose IDs are namespaced differently by the serving layer (e.g. a Bedrock
	 * model whose `id` is `"anthropic.claude-opus-4-6-…"` but whose
	 * `originProvider` is `"anthropic"`).
	 *
	 * Lookup order:
	 *   1. Exact `id` match
	 *   2. `{provider}/{id}` format
	 *   3. `{originProvider}/{id}` (when originProvider differs from provider)
	 *   4. `{originProvider}/{normalizedId}` — strips prefix/date suffixes
	 *   5. Lowercase exact `id` match
	 *   6. Lowercase `{provider}/{id}`
	 *   7. Lowercase `{originProvider}/{normalizedId}`
	 */
	private lookupModel(model: ModelCard): LiteLLMModelEntry | undefined {
		if (!this.data) return undefined;

		const { id, provider, originProvider } = model;

		// 1. Exact match
		if (this.data[id]) return this.data[id];

		// 2. provider/id format
		const prefixed = `${provider}/${id}`;
		if (this.data[prefixed]) return this.data[prefixed];

		// 3. originProvider/id — useful when the serving layer prefixes IDs
		//    differently (e.g. bedrock → anthropic).
		if (originProvider && originProvider !== provider) {
			const originPrefixed = `${originProvider}/${id}`;
			if (this.data[originPrefixed]) return this.data[originPrefixed];
		}

		// 4. originProvider/normalizedId — strips date suffixes and provider
		//    namespace segments so "anthropic.claude-opus-4-6-20250514-v1:0"
		//    resolves to "anthropic/claude-opus-4-6".
		const normalizedId = normalizeModelId(id);
		if (originProvider) {
			const originNormPrefixed = `${originProvider}/${normalizedId}`;
			if (this.data[originNormPrefixed]) return this.data[originNormPrefixed];
		}

		// 5. Lowercase exact match
		const lower = id.toLowerCase();
		if (this.data[lower]) return this.data[lower];

		// 6. Lowercase provider/id
		const lowerPrefixed = `${provider}/${lower}`;
		if (this.data[lowerPrefixed]) return this.data[lowerPrefixed];

		// 7. Lowercase originProvider/normalizedId
		if (originProvider) {
			const lowerOriginNorm = `${originProvider}/${normalizedId.toLowerCase()}`;
			if (this.data[lowerOriginNorm]) return this.data[lowerOriginNorm];
		}

		return undefined;
	}

	/** Convert litellm per-token costs to per-million pricing. */
	private extractPricing(entry: LiteLLMModelEntry): ModelPricing | undefined {
		if (entry.input_cost_per_token === undefined && entry.output_cost_per_token === undefined) {
			return undefined;
		}

		const pricing: ModelPricing = {
			inputPerMillion: (entry.input_cost_per_token ?? 0) * PER_MILLION,
			outputPerMillion: (entry.output_cost_per_token ?? 0) * PER_MILLION,
		};

		if (entry.cache_read_input_token_cost !== undefined) {
			pricing.cacheReadPerMillion = entry.cache_read_input_token_cost * PER_MILLION;
		}
		if (entry.cache_creation_input_token_cost !== undefined) {
			pricing.cacheWritePerMillion = entry.cache_creation_input_token_cost * PER_MILLION;
		}

		return pricing;
	}

	/** Map litellm mode strings to our ModelMode type. */
	private mapMode(mode: string): ModelMode | undefined {
		switch (mode) {
			case "chat":
			case "completion":
				return "chat";
			case "embedding":
				return "embedding";
			case "image_generation":
				return "image";
			case "audio_transcription":
			case "audio_speech":
				return "audio";
			case "moderation":
				return "moderation";
			default:
				return undefined;
		}
	}
}
