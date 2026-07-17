/**
 * kosha-discovery — LiteLLM community data enrichment.
 *
 * Fetches the community-maintained litellm model catalogue from GitHub
 * and uses it to fill in pricing, context window sizes, and capability
 * flags on already-discovered {@link ModelCard} objects.
 * @module
 */

import type { Enricher, ModelCard, ModelMode, ModelPricing, ModelStatus } from "../types.js";
import { applyFreeTierFlag } from "../discovery/free-tier.js";
import { normalizeModelId } from "../normalize.js";
import { inferParallelToolCalls, inferStructuredOutputModes, inferToolDialect } from "../model-features.js";
import { inferTokenizerFamily } from "../tokenizer-family.js";
import { type LiteLLMModelEntry, loadLiteLLMCatalog } from "./litellm-catalog.js";

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

	/** Fetch and cache the litellm pricing JSON via the shared catalog loader. */
	async load(): Promise<void> {
		if (this.data) return;
		this.data = await loadLiteLLMCatalog();
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
		return models.map((model) => applyFreeTierFlag(this.enrichOne(model)));
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private enrichOne(model: ModelCard): ModelCard {
		const entry = this.lookupModel(model);
		if (!entry) return { ...model };

		const enriched: ModelCard = { ...model };

		// Pricing — fill in base pricing when missing, AND top up cache rates
		// even when base pricing already exists. The discoverer (e.g. OpenRouter)
		// often provides input/output rates but skips cache_read/cache_write,
		// while litellm has them — so I merge per-field rather than all-or-nothing.
		const entryPricing = this.extractPricing(entry);
		if (entryPricing) {
			if (!enriched.pricing) {
				enriched.pricing = entryPricing;
			} else {
				if (
					enriched.pricing.cacheReadPerMillion === undefined &&
					entryPricing.cacheReadPerMillion !== undefined
				) {
					enriched.pricing = {
						...enriched.pricing,
						cacheReadPerMillion: entryPricing.cacheReadPerMillion,
					};
				}
				if (
					enriched.pricing.cacheWritePerMillion === undefined &&
					entryPricing.cacheWritePerMillion !== undefined
				) {
					enriched.pricing = {
						...enriched.pricing,
						cacheWritePerMillion: entryPricing.cacheWritePerMillion,
					};
				}
				if (
					enriched.pricing.batchInputPerMillion === undefined &&
					entryPricing.batchInputPerMillion !== undefined
				) {
					enriched.pricing = {
						...enriched.pricing,
						batchInputPerMillion: entryPricing.batchInputPerMillion,
					};
				}
				if (
					enriched.pricing.batchOutputPerMillion === undefined &&
					entryPricing.batchOutputPerMillion !== undefined
				) {
					enriched.pricing = {
						...enriched.pricing,
						batchOutputPerMillion: entryPricing.batchOutputPerMillion,
					};
				}
			}
		}

		// Preserve proxy-route pricing while surfacing direct-origin reference pricing.
		if (entryPricing && enriched.originProvider && enriched.originProvider !== enriched.provider && !enriched.originPricing) {
			enriched.originPricing = entryPricing;
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
		if (entry.supports_audio_input && !enriched.capabilities.includes("audio_input")) {
			enriched.capabilities.push("audio_input");
		}
		if (entry.supports_audio_output && !enriched.capabilities.includes("audio_output")) {
			enriched.capabilities.push("audio_output");
		}
		if (entry.supports_video_input && !enriched.capabilities.includes("video_input")) {
			enriched.capabilities.push("video_input");
		}
		if (entry.supports_reasoning && !enriched.capabilities.includes("reasoning")) {
			enriched.capabilities.push("reasoning");
		}
		if (entry.supports_response_schema && !enriched.capabilities.includes("structured_output")) {
			enriched.capabilities.push("structured_output");
		}

		// Tokenizer family — only fill when missing. Prefer a local-runtime value
		// when the discoverer already supplied one; fall back to heuristic inference
		// based on origin provider and model ID.
		if (!enriched.tokenizerFamily) {
			const localFamily = enriched.localRuntime?.tokenizerFamily;
			enriched.tokenizerFamily =
				localFamily ?? inferTokenizerFamily(enriched.originProvider, enriched.id);
		}

		// Tool dialect — only fill when missing. The discoverer might know the
		// canonical dialect for managed proxy endpoints; we only infer when it
		// didn't come through.
		if (enriched.toolDialect === undefined) {
			const dialect = inferToolDialect(enriched.originProvider, enriched.id);
			if (dialect !== undefined) enriched.toolDialect = dialect;
		}

		// Structured output modes — only fill when the discoverer hasn't set them.
		if (enriched.structuredOutputModes === undefined) {
			const modes = inferStructuredOutputModes(enriched.originProvider, enriched.id);
			if (modes.length > 0) enriched.structuredOutputModes = modes;
		}

		// Parallel tool calls — litellm's flag takes precedence when present,
		// otherwise fall back to the heuristic from the dialect / model ID.
		if (enriched.supportsParallelToolCalls === undefined) {
			if (entry.supports_parallel_function_calling !== undefined) {
				enriched.supportsParallelToolCalls = entry.supports_parallel_function_calling;
			} else {
				const parallel = inferParallelToolCalls(enriched.originProvider, enriched.id);
				if (parallel !== undefined) enriched.supportsParallelToolCalls = parallel;
			}
		}

		// Deprecation metadata — only fill when missing; litellm publishes
		// `deprecation_date` as an ISO string for models with announced sunset.
		if (!enriched.deprecationDate && entry.deprecation_date) {
			enriched.deprecationDate = entry.deprecation_date;
		}
		if (!enriched.status) {
			enriched.status = this.inferStatus(enriched.deprecationDate);
		}

		return enriched;
	}

	/**
	 * Best-effort lifecycle status from a deprecation-date string.
	 *
	 * Returns `"retired"` when the date has already passed,
	 * `"deprecated"` when one is set but still in the future,
	 * and `"active"` when no date is present.
	 */
	private inferStatus(deprecationDate?: string): ModelStatus {
		if (!deprecationDate) return "active";
		const ts = Date.parse(deprecationDate);
		if (Number.isNaN(ts)) return "active";
		return ts <= Date.now() ? "retired" : "deprecated";
	}

	/**
	 * Look up a model in the litellm pricing catalogue using a tiered set of
	 * key strategies. Later strategies use `originProvider` to handle models
	 * whose IDs are namespaced differently by the serving layer (e.g. a Bedrock
	 * model whose `id` is `"anthropic.claude-opus-4-8-…"` but whose
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
		//    namespace segments so "anthropic.claude-opus-4-8-20250514-v1:0"
		//    resolves to "anthropic/claude-opus-4-8".
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
		const reasoningInputCost = this.firstFinite(
			entry.input_cost_per_reasoning_token,
			entry.reasoning_input_cost_per_token,
		);
		const reasoningOutputCost = this.firstFinite(
			entry.output_cost_per_reasoning_token,
			entry.reasoning_output_cost_per_token,
		);

		const baseInput = this.firstFinite(entry.input_cost_per_token);
		const baseOutput = this.firstFinite(entry.output_cost_per_token);
		const hasBaseTokenPricing = baseInput !== undefined && baseOutput !== undefined;

		// Multimodal-only entries (TTS by-the-second, image generation, per-character
		// Vertex models) legitimately publish no token-billed pricing — synthesizing
		// 0/0 base on those is honest, and downstream free_tier detection skips
		// non-chat modes. Cache-only / batch-only / reasoning-only entries, on the
		// other hand, are incomplete catalog rows: synthesizing 0/0 base from them
		// would falsely flag the model as free_tier, so we refuse.
		const hasNonTokenPricing =
			entry.input_cost_per_image !== undefined ||
			entry.output_cost_per_image !== undefined ||
			entry.input_cost_per_audio_token !== undefined ||
			entry.output_cost_per_audio_token !== undefined ||
			entry.input_cost_per_audio_per_second !== undefined ||
			entry.output_cost_per_audio_per_second !== undefined ||
			entry.input_cost_per_video_per_second !== undefined ||
			entry.output_cost_per_video_per_second !== undefined ||
			entry.input_cost_per_video_token !== undefined ||
			entry.input_cost_per_character !== undefined ||
			entry.output_cost_per_character !== undefined;

		if (!hasBaseTokenPricing && !hasNonTokenPricing) {
			return undefined;
		}

		const pricing: ModelPricing = {
			inputPerMillion: (baseInput ?? 0) * PER_MILLION,
			outputPerMillion: (baseOutput ?? 0) * PER_MILLION,
		};
		if (reasoningInputCost !== undefined) {
			pricing.reasoningInputPerMillion = reasoningInputCost * PER_MILLION;
		}
		if (reasoningOutputCost !== undefined) {
			pricing.reasoningOutputPerMillion = reasoningOutputCost * PER_MILLION;
		}

		if (entry.cache_read_input_token_cost !== undefined) {
			pricing.cacheReadPerMillion = entry.cache_read_input_token_cost * PER_MILLION;
		}
		if (entry.cache_creation_input_token_cost !== undefined) {
			pricing.cacheWritePerMillion = entry.cache_creation_input_token_cost * PER_MILLION;
		}

		if (entry.input_cost_per_token_batches !== undefined) {
			pricing.batchInputPerMillion = entry.input_cost_per_token_batches * PER_MILLION;
		}
		if (entry.output_cost_per_token_batches !== undefined) {
			pricing.batchOutputPerMillion = entry.output_cost_per_token_batches * PER_MILLION;
		}

		// Multimodal — images are already per-unit; audio/video tokens go through PER_MILLION.
		if (entry.input_cost_per_image !== undefined) {
			pricing.imageInputPerImage = entry.input_cost_per_image;
		}
		if (entry.output_cost_per_image !== undefined) {
			pricing.imageOutputPerImage = entry.output_cost_per_image;
		}
		if (entry.input_cost_per_audio_token !== undefined) {
			pricing.audioInputPerMillion = entry.input_cost_per_audio_token * PER_MILLION;
		}
		if (entry.output_cost_per_audio_token !== undefined) {
			pricing.audioOutputPerMillion = entry.output_cost_per_audio_token * PER_MILLION;
		}
		if (entry.input_cost_per_audio_per_second !== undefined) {
			pricing.audioInputPerSecond = entry.input_cost_per_audio_per_second;
		}
		if (entry.output_cost_per_audio_per_second !== undefined) {
			pricing.audioOutputPerSecond = entry.output_cost_per_audio_per_second;
		}
		if (entry.input_cost_per_video_per_second !== undefined) {
			pricing.videoInputPerSecond = entry.input_cost_per_video_per_second;
		}
		if (entry.output_cost_per_video_per_second !== undefined) {
			pricing.videoOutputPerSecond = entry.output_cost_per_video_per_second;
		}
		if (entry.input_cost_per_video_token !== undefined) {
			pricing.videoInputPerMillion = entry.input_cost_per_video_token * PER_MILLION;
		}

		// Character-billed providers (Vertex AI, Azure).
		if (entry.input_cost_per_character !== undefined) {
			pricing.inputPerMillionCharacters = entry.input_cost_per_character * PER_MILLION;
		}
		if (entry.output_cost_per_character !== undefined) {
			pricing.outputPerMillionCharacters = entry.output_cost_per_character * PER_MILLION;
		}

		// Tiered long-context pricing — prefer 128k, fall back to 200k (Claude-style).
		const tieredIn = this.firstFinite(
			entry.input_cost_per_token_above_128k_tokens,
			entry.input_cost_per_token_above_200k_tokens,
		);
		const tieredOut = this.firstFinite(
			entry.output_cost_per_token_above_128k_tokens,
			entry.output_cost_per_token_above_200k_tokens,
		);
		if (tieredIn !== undefined) {
			pricing.longContextInputPerMillion = tieredIn * PER_MILLION;
		}
		if (tieredOut !== undefined) {
			pricing.longContextOutputPerMillion = tieredOut * PER_MILLION;
		}
		if (entry.input_cost_per_token_above_128k_tokens !== undefined || entry.output_cost_per_token_above_128k_tokens !== undefined) {
			pricing.longContextThresholdTokens = 128_000;
		} else if (entry.input_cost_per_token_above_200k_tokens !== undefined || entry.output_cost_per_token_above_200k_tokens !== undefined) {
			pricing.longContextThresholdTokens = 200_000;
		}

		return pricing;
	}

	/**
	 * Return the first defined finite number from a list of optional values.
	 * This allows tolerant support for field-name variants in upstream data.
	 */
	private firstFinite(...values: Array<number | undefined>): number | undefined {
		for (const value of values) {
			if (typeof value === "number" && Number.isFinite(value)) {
				return value;
			}
		}
		return undefined;
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
			case "video_generation":
				return "video";
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
