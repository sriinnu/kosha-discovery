/**
 * kosha-discovery — LiteLLM community data enrichment.
 *
 * Fetches the community-maintained litellm model catalogue from GitHub
 * and uses it to fill in pricing, context window sizes, and capability
 * flags on already-discovered {@link ModelCard} objects.
 * @module
 */

import { applyFreeTierFlag, isPlanBilled } from "../discovery/free-tier.js";
import { extractLiteLLMPricing } from "../discovery/litellm-seed.js";
import { inferParallelToolCalls, inferStructuredOutputModes, inferToolDialect } from "../model-features.js";
import { normalizeModelId } from "../normalize.js";
import { normalizeProviderId } from "../provider-catalog.js";
import { inferTokenizerFamily } from "../tokenizer-family.js";
import type { Enricher, ModelCard, ModelMode, ModelPricing, ModelStatus } from "../types.js";
import { type LiteLLMModelEntry, loadLiteLLMCatalog } from "./litellm-catalog.js";

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
	async enrich(models: ModelCard[], options?: { refreshExisting?: boolean }): Promise<ModelCard[]> {
		await this.load();
		return models.map((model) => applyFreeTierFlag(this.enrichOne(model, options)));
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private enrichOne(model: ModelCard, options?: { refreshExisting?: boolean }): ModelCard {
		const entry = this.lookupModel(model);
		const originNorm = model.originProvider
			? (normalizeProviderId(model.originProvider) ?? model.originProvider)
			: undefined;
		const servingNorm = normalizeProviderId(model.provider) ?? model.provider;
		const isProxyRoute = Boolean(originNorm && originNorm !== servingNorm);
		const pricingEntry = isProxyRoute ? this.lookupServingModel(model) : entry;
		if (!entry && !pricingEntry) return { ...model };

		const enriched: ModelCard = { ...model };

		// Pricing — fill in base pricing when missing, refresh aggregator rates on
		// explicit `kosha enrich`, and top up secondary cache/media rates without
		// copying an origin maker's price onto a reseller/proxy route.
		const entryPricing = pricingEntry ? this.extractPricing(pricingEntry) : undefined;
		if (entryPricing && !isPlanBilled(enriched)) {
			if (!enriched.pricing) {
				enriched.pricing = entryPricing;
				enriched.pricingSource ??= "litellm";
			} else if (options?.refreshExisting && enriched.pricingSource !== "provider-live") {
				enriched.pricing = { ...enriched.pricing, ...entryPricing };
				enriched.pricingSource = "litellm";
			} else {
				const mergedPricing = { ...enriched.pricing };
				for (const key of [
					"reasoningInputPerMillion",
					"reasoningOutputPerMillion",
					"cacheReadPerMillion",
					"cacheWritePerMillion",
					"cacheWrite1hPerMillion",
					"cacheStoragePerMillionPerHour",
					"batchInputPerMillion",
					"batchOutputPerMillion",
					"longContextInputPerMillion",
					"longContextOutputPerMillion",
					"longContextThresholdTokens",
					"imageInputPerImage",
					"imageOutputPerImage",
					"audioInputPerMillion",
					"audioOutputPerMillion",
					"audioInputPerSecond",
					"audioOutputPerSecond",
					"videoInputPerSecond",
					"videoOutputPerSecond",
					"videoInputPerMillion",
					"inputPerMillionCharacters",
					"outputPerMillionCharacters",
				] as const) {
					if (mergedPricing[key] === undefined && entryPricing[key] !== undefined) {
						(mergedPricing as Record<string, unknown>)[key] = entryPricing[key];
					}
				}
				enriched.pricing = mergedPricing;
			}
		}

		// Preserve proxy-route pricing while surfacing direct-origin reference pricing
		// sourced ONLY from origin-provider entries (never a reseller's proxy row).
		if (originNorm && originNorm !== servingNorm && !enriched.originPricing) {
			const originEntry = this.lookupOriginModel(enriched);
			const originPricing = originEntry ? this.extractPricing(originEntry) : undefined;
			if (originPricing) {
				enriched.originPricing = originPricing;
			}
		}

		if (!entry) return enriched;

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

		// Capabilities — add missing ones from litellm flags to both capabilities and rawCapabilities
		enriched.capabilities = [...enriched.capabilities];
		const rawCaps = [...(enriched.rawCapabilities ?? enriched.capabilities)];
		const addCapability = (flag: string): void => {
			if (!enriched.capabilities.includes(flag)) enriched.capabilities.push(flag);
			if (!rawCaps.includes(flag)) rawCaps.push(flag);
		};
		if (entry.supports_vision) addCapability("vision");
		if (entry.supports_function_calling) addCapability("function_calling");
		if (entry.supports_prompt_caching) addCapability("prompt_caching");
		if (entry.supports_audio_input) addCapability("audio_input");
		if (entry.supports_audio_output) addCapability("audio_output");
		if (entry.supports_video_input) addCapability("video_input");
		if (entry.supports_reasoning) addCapability("reasoning");
		if (entry.supports_response_schema) addCapability("structured_output");
		enriched.rawCapabilities = rawCaps;

		// Tokenizer family — only fill when missing. Prefer a local-runtime value
		// when the discoverer already supplied one; fall back to heuristic inference
		// based on origin provider and model ID.
		if (!enriched.tokenizerFamily) {
			const localFamily = enriched.localRuntime?.tokenizerFamily;
			enriched.tokenizerFamily = localFamily ?? inferTokenizerFamily(enriched.originProvider, enriched.id);
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

		// 1. Serving-provider prefixed match first so resellers don't collide on bare names
		const prefixed = `${provider}/${id}`;
		if (this.data[prefixed]) return this.data[prefixed];

		// 2. originProvider/id — useful when the serving layer prefixes IDs
		//    differently (e.g. bedrock → anthropic).
		if (originProvider && originProvider !== provider) {
			const originPrefixed = `${originProvider}/${id}`;
			if (this.data[originPrefixed]) return this.data[originPrefixed];
		}

		// 3. Bare exact match
		if (this.data[id]) return this.data[id];

		// 4. originProvider/normalizedId — strips date suffixes and provider
		//    namespace segments so "anthropic.claude-opus-4-8-20250514-v1:0"
		//    resolves to "anthropic/claude-opus-4-8".
		const normalizedId = normalizeModelId(id);
		if (originProvider) {
			const originNormPrefixed = `${originProvider}/${normalizedId}`;
			if (this.data[originNormPrefixed]) return this.data[originNormPrefixed];
		}

		// 5. Lowercase provider/id
		const lower = id.toLowerCase();
		const lowerPrefixed = `${provider}/${lower}`;
		if (this.data[lowerPrefixed]) return this.data[lowerPrefixed];

		// 6. Lowercase bare exact match
		if (this.data[lower]) return this.data[lower];

		// 7. Lowercase originProvider/normalizedId
		if (originProvider) {
			const lowerOriginNorm = `${originProvider}/${normalizedId.toLowerCase()}`;
			if (this.data[lowerOriginNorm]) return this.data[lowerOriginNorm];
		}

		return undefined;
	}

	/**
	 * Look up the direct-origin entry for a proxy/reseller model so a reseller's
	 * own `{provider}/{id}` proxy price is never copied into `originPricing`.
	 */
	private lookupServingModel(model: ModelCard): LiteLLMModelEntry | undefined {
		if (!this.data) return undefined;
		const { id, provider } = model;
		const lower = id.toLowerCase();
		const servingNorm = (normalizeProviderId(provider) ?? provider).toLowerCase();
		const providerLower = provider.toLowerCase();

		for (const candidate of [`${provider}/${id}`, `${provider}/${lower}`, `${servingNorm}/${id}`, `${servingNorm}/${lower}`]) {
			if (this.data[candidate]) return this.data[candidate];
		}

		for (const bareCandidate of [id, lower]) {
			const row = this.data[bareCandidate];
			if (!row) continue;
			const rp = row.litellm_provider?.toLowerCase();
			if (
				rp &&
				(rp === providerLower ||
					rp === servingNorm ||
					rp.startsWith(`${providerLower}-`) ||
					rp.startsWith(`${providerLower}_`) ||
					rp.startsWith(`${servingNorm}-`) ||
					rp.startsWith(`${servingNorm}_`))
			) {
				return row;
			}
		}
		return undefined;
	}

	private lookupOriginModel(model: ModelCard): LiteLLMModelEntry | undefined {
		if (!this.data || !model.originProvider) return undefined;
		const origin = normalizeProviderId(model.originProvider) ?? model.originProvider;
		const { id } = model;
		const normalizedId = normalizeModelId(id);
		const lower = id.toLowerCase();
		const lowerNorm = normalizedId.toLowerCase();

		for (const candidate of [
			`${origin}/${id}`,
			`${origin}/${normalizedId}`,
			`${origin}/${lower}`,
			`${origin}/${lowerNorm}`,
		]) {
			if (this.data[candidate]) return this.data[candidate];
		}

		// Bare ID only matches when LiteLLM tags the row with the same origin provider.
		for (const bareCandidate of [id, lower, normalizedId, lowerNorm]) {
			const row = this.data[bareCandidate];
			if (!row) continue;
			const rowProvider = row.litellm_provider?.toLowerCase();
			if (rowProvider === origin || (origin === "google" && rowProvider === "gemini")) {
				return row;
			}
		}
		return undefined;
	}

	/** Convert litellm per-token costs to per-million pricing. */
	private extractPricing(entry: LiteLLMModelEntry): ModelPricing | undefined {
		return extractLiteLLMPricing(entry);
	}

	/** Map litellm mode strings to our ModelMode type. */
	private mapMode(mode: string): ModelMode | undefined {
		switch (mode) {
			case "chat":
			case "completion":
				return "chat";
			case "embedding":
				return "embedding";
			case "rerank":
				return "rerank";
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
