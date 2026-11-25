/**
 * kosha-discovery — Public-catalog seed for origin providers.
 *
 * Treats the LiteLLM community catalog as the canonical *public* source of
 * "what models exist with what pricing/context/capabilities" and converts
 * it into seed {@link ModelCard} arrays per origin provider.
 *
 * This decouples kosha discovery from API keys: anyone running `kosha
 * latest`, with or without credentials, gets the current state of the
 * world for every supported origin provider.
 *
 * Hardening notes:
 *  - All fields are read defensively (`typeof` checks, length caps).
 *  - Synthetic IDs are slugified to strict `[A-Za-z0-9._/:-]` so a
 *    compromised catalog cannot smuggle injection-shaped strings into
 *    downstream consumers.
 *  - The maximum number of seeded models per provider is capped to bound
 *    cost of a hostile catalog.
 * @module
 */

import type { ModelCard, ModelMode, ModelPricing } from "../types.js";
import { applyFreeTierFlag } from "./free-tier.js";
import {
	type LiteLLMModelEntry,
	loadLiteLLMCatalog,
} from "../enrichment/litellm-catalog.js";

/** Per-token cost → per-million conversion factor. */
const PER_MILLION = 1_000_000;

/** Maximum models seeded for a single provider — defensive ceiling. */
const MAX_MODELS_PER_SEED = 1_000;

/** Strict charset for model IDs; everything else gets stripped or rejected. */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/** Maximum length we accept for a model ID. */
const MAX_ID_LENGTH = 256;

/**
 * Map kosha provider IDs (the slugs used internally) to the set of
 * `litellm_provider` values that should be treated as the same origin.
 * LiteLLM's slugs differ from kosha's in a few places (`gemini`, `together_ai`,
 * `fireworks_ai`, etc.), so we alias them here rather than scattering
 * conditionals across discoverers.
 */
const PROVIDER_SLUG_ALIASES: Record<string, readonly string[]> = {
	anthropic: ["anthropic"],
	openai: ["openai"],
	google: ["gemini", "vertex_ai-language-models", "vertex_ai-image-models", "vertex_ai-embedding-models"],
	deepseek: ["deepseek"],
	zai: ["zai"],
	minimax: ["minimax"],
	moonshot: ["moonshot"],
	mistral: ["mistral"],
	cohere: ["cohere", "cohere_chat"],
	groq: ["groq"],
	together: ["together_ai"],
	fireworks: ["fireworks_ai"],
	perplexity: ["perplexity"],
	cerebras: ["cerebras"],
	deepinfra: ["deepinfra"],
	xai: ["xai"],
	glm: ["zhipu", "zhipuai"],
	alibaba: ["dashscope"],
	volcengine: ["volcengine"],
	nebius: ["nebius"],
	novita: ["novita"],
	huggingface: ["huggingface"],
	ai21: ["ai21"],
};

/**
 * Build a fresh array of seed {@link ModelCard}s for the given kosha
 * provider ID, using the shared LiteLLM catalog. Returns `[]` if the
 * provider has no entries in the catalog.
 *
 * The returned cards have `source: "litellm"` so downstream consumers
 * (and the existing pricing enricher) can distinguish public-catalog
 * data from live-API data.
 */
const groupedCatalogCache = new WeakMap<
	Record<string, LiteLLMModelEntry>,
	Map<string, Array<[string, LiteLLMModelEntry]>>
>();

function getCatalogByLiteLLMProvider(
	catalog: Record<string, LiteLLMModelEntry>,
): Map<string, Array<[string, LiteLLMModelEntry]>> {
	const cached = groupedCatalogCache.get(catalog);
	if (cached) return cached;
	const grouped = new Map<string, Array<[string, LiteLLMModelEntry]>>();
	for (const [key, entry] of Object.entries(catalog)) {
		if (!entry || typeof entry !== "object") continue;
		const litellmProvider = entry.litellm_provider;
		if (typeof litellmProvider !== "string") continue;
		let bucket = grouped.get(litellmProvider);
		if (!bucket) {
			bucket = [];
			grouped.set(litellmProvider, bucket);
		}
		bucket.push([key, entry]);
	}
	groupedCatalogCache.set(catalog, grouped);
	return grouped;
}

export async function getLiteLLMSeed(providerId: string): Promise<ModelCard[]> {
	const slugs = PROVIDER_SLUG_ALIASES[providerId];
	if (!slugs || slugs.length === 0) return [];

	const catalog = await loadLiteLLMCatalog();
	const grouped = getCatalogByLiteLLMProvider(catalog);
	const seeds: ModelCard[] = [];
	const seenIds = new Set<string>();

	for (const slug of slugs) {
		const entries = grouped.get(slug);
		if (!entries) continue;
		for (const [key, entry] of entries) {
			if (seeds.length >= MAX_MODELS_PER_SEED) break;

			const id = canonicaliseModelId(key, providerId);
			if (!id || seenIds.has(id)) continue;
			seenIds.add(id);

			const card = buildSeedCard(id, providerId, entry);
			if (card) seeds.push(card);
		}
		if (seeds.length >= MAX_MODELS_PER_SEED) break;
	}

	return seeds;
}

/**
 * Strip a LiteLLM catalog key down to the provider-native model ID.
 *
 * LiteLLM keys come in three shapes:
 *   1. Bare ID:         `claude-opus-4-7`
 *   2. Prefixed:        `anthropic/claude-opus-4-7`
 *   3. Path-prefixed:   `vertex_ai/claude-opus-4-7@default`
 *
 * Returns null when the key is not safe (oversized, illegal chars,
 * or empty after stripping).
 */
function canonicaliseModelId(rawKey: string, providerId: string): string | null {
	if (typeof rawKey !== "string" || rawKey.length === 0 || rawKey.length > MAX_ID_LENGTH) {
		return null;
	}

	// Drop everything before the last `/`. Most public catalogs prefix the
	// vendor; kosha stores the bare provider-native ID.
	let id = rawKey.includes("/") ? rawKey.slice(rawKey.lastIndexOf("/") + 1) : rawKey;

	// Drop deployment suffixes after `@` (Vertex naming).
	const atIdx = id.indexOf("@");
	if (atIdx > 0) id = id.slice(0, atIdx);

	if (!SAFE_ID_PATTERN.test(id)) return null;

	// Skip pseudo entries the catalog uses for documentation (e.g. "sample_spec").
	if (id === "sample_spec") return null;

	// For Google: only keep the gemini-* family, not other vertex bundle entries
	// that aren't real model IDs.
	if (providerId === "google" && !id.startsWith("gemini") && !id.startsWith("imagen") && !id.startsWith("veo")) {
		return null;
	}

	return id;
}

/**
 * Convert a single LiteLLM entry into a {@link ModelCard}. Returns null
 * when the entry is too sparse to be useful (e.g. no mode and no pricing
 * signal at all).
 */
function buildSeedCard(id: string, providerId: string, entry: LiteLLMModelEntry): ModelCard | null {
	const mode = inferMode(entry);
	const capabilities = inferCapabilities(entry, mode);
	const pricing = extractPricing(entry);
	const contextWindow = pickPositive(entry.max_input_tokens, entry.max_tokens) ?? 0;
	const maxOutputTokens = pickPositive(entry.max_output_tokens, entry.max_tokens) ?? 0;

	const card: ModelCard = {
		id,
		name: id,
		provider: providerId,
		originProvider: providerId,
		mode,
		capabilities,
		rawCapabilities: [...capabilities],
		contextWindow,
		maxOutputTokens,
		maxInputTokens: pickPositive(entry.max_input_tokens),
		dimensions: pickPositive(entry.output_vector_size),
		pricing,
		aliases: [],
		discoveredAt: Date.now(),
		source: "litellm",
		catalogSource: "litellm",
	};
	return applyFreeTierFlag(card);
}

/** Pick the first finite, positive number from a list of optional values. */
function pickPositive(...values: Array<number | undefined>): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

/** Map LiteLLM mode strings to the kosha ModelMode union. */
function inferMode(entry: LiteLLMModelEntry): ModelMode {
	switch (entry.mode) {
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
		case "rerank":
			return "rerank";
		default:
			return "chat";
	}
}

/** Infer kosha capability flags from LiteLLM's structured boolean fields. */
function inferCapabilities(entry: LiteLLMModelEntry, mode: ModelMode): string[] {
	if (mode === "embedding") return ["embedding"];
	if (mode === "image") return ["image_generation"];
	if (mode === "video") return ["video_generation"];
	if (mode === "audio") return ["audio"];
	if (mode === "moderation") return ["moderation"];
	if (mode === "rerank") return ["rerank"];

	const caps = new Set<string>(["chat"]);
	if (entry.supports_vision) caps.add("vision");
	if (entry.supports_function_calling || entry.supports_tool_choice) caps.add("function_calling");
	if (entry.supports_prompt_caching) caps.add("prompt_caching");
	if (entry.supports_response_schema) caps.add("structured_output");
	// Most modern chat models cover code / NLU; LiteLLM doesn't expose those
	// flags, but kosha consumers expect them present for chat-class models.
	caps.add("code");
	caps.add("nlu");
	return Array.from(caps);
}

/**
 * Convert LiteLLM costs into kosha's {@link ModelPricing} format.
 * Returns undefined unless both base token rates or multimodal unit rates are present.
 */
export function extractLiteLLMPricing(entry: LiteLLMModelEntry): ModelPricing | undefined {
	const reasoningInputCost = firstFinite(entry.input_cost_per_reasoning_token, entry.reasoning_input_cost_per_token);
	const reasoningOutputCost = firstFinite(entry.output_cost_per_reasoning_token, entry.reasoning_output_cost_per_token);

	const baseInput = isFiniteNumber(entry.input_cost_per_token) ? entry.input_cost_per_token : undefined;
	const baseOutput = isFiniteNumber(entry.output_cost_per_token) ? entry.output_cost_per_token : undefined;
	const hasBaseTokenPricing = baseInput !== undefined && baseOutput !== undefined;

	const hasNonTokenPricing =
		isFiniteNumber(entry.input_cost_per_image) ||
		isFiniteNumber(entry.output_cost_per_image) ||
		isFiniteNumber(entry.input_cost_per_audio_token) ||
		isFiniteNumber(entry.output_cost_per_audio_token) ||
		isFiniteNumber(entry.input_cost_per_audio_per_second) ||
		isFiniteNumber(entry.output_cost_per_audio_per_second) ||
		isFiniteNumber(entry.input_cost_per_video_per_second) ||
		isFiniteNumber(entry.output_cost_per_video_per_second) ||
		isFiniteNumber(entry.input_cost_per_video_token) ||
		isFiniteNumber(entry.input_cost_per_character) ||
		isFiniteNumber(entry.output_cost_per_character);

	if (!hasBaseTokenPricing && !hasNonTokenPricing) return undefined;

	const pricing: ModelPricing = {
		inputPerMillion: (baseInput ?? 0) * PER_MILLION,
		outputPerMillion: (baseOutput ?? 0) * PER_MILLION,
	};
	if (reasoningInputCost !== undefined) pricing.reasoningInputPerMillion = reasoningInputCost * PER_MILLION;
	if (reasoningOutputCost !== undefined) pricing.reasoningOutputPerMillion = reasoningOutputCost * PER_MILLION;
	if (isFiniteNumber(entry.cache_read_input_token_cost)) {
		pricing.cacheReadPerMillion = entry.cache_read_input_token_cost * PER_MILLION;
	}
	if (isFiniteNumber(entry.cache_creation_input_token_cost)) {
		pricing.cacheWritePerMillion = entry.cache_creation_input_token_cost * PER_MILLION;
	}
	if (isFiniteNumber(entry.input_cost_per_token_batches)) {
		pricing.batchInputPerMillion = entry.input_cost_per_token_batches * PER_MILLION;
	}
	if (isFiniteNumber(entry.output_cost_per_token_batches)) {
		pricing.batchOutputPerMillion = entry.output_cost_per_token_batches * PER_MILLION;
	}
	if (isFiniteNumber(entry.input_cost_per_image)) pricing.imageInputPerImage = entry.input_cost_per_image;
	if (isFiniteNumber(entry.output_cost_per_image)) pricing.imageOutputPerImage = entry.output_cost_per_image;
	if (isFiniteNumber(entry.input_cost_per_audio_token)) {
		pricing.audioInputPerMillion = entry.input_cost_per_audio_token * PER_MILLION;
	}
	if (isFiniteNumber(entry.output_cost_per_audio_token)) {
		pricing.audioOutputPerMillion = entry.output_cost_per_audio_token * PER_MILLION;
	}
	if (isFiniteNumber(entry.input_cost_per_audio_per_second)) {
		pricing.audioInputPerSecond = entry.input_cost_per_audio_per_second;
	}
	if (isFiniteNumber(entry.output_cost_per_audio_per_second)) {
		pricing.audioOutputPerSecond = entry.output_cost_per_audio_per_second;
	}
	if (isFiniteNumber(entry.input_cost_per_video_per_second)) {
		pricing.videoInputPerSecond = entry.input_cost_per_video_per_second;
	}
	if (isFiniteNumber(entry.output_cost_per_video_per_second)) {
		pricing.videoOutputPerSecond = entry.output_cost_per_video_per_second;
	}
	if (isFiniteNumber(entry.input_cost_per_video_token)) {
		pricing.videoInputPerMillion = entry.input_cost_per_video_token * PER_MILLION;
	}
	if (isFiniteNumber(entry.input_cost_per_character)) {
		pricing.inputPerMillionCharacters = entry.input_cost_per_character * PER_MILLION;
	}
	if (isFiniteNumber(entry.output_cost_per_character)) {
		pricing.outputPerMillionCharacters = entry.output_cost_per_character * PER_MILLION;
	}

	const tieredIn = firstFinite(entry.input_cost_per_token_above_128k_tokens, entry.input_cost_per_token_above_200k_tokens);
	const tieredOut = firstFinite(entry.output_cost_per_token_above_128k_tokens, entry.output_cost_per_token_above_200k_tokens);
	if (tieredIn !== undefined) pricing.longContextInputPerMillion = tieredIn * PER_MILLION;
	if (tieredOut !== undefined) pricing.longContextOutputPerMillion = tieredOut * PER_MILLION;
	if (
		isFiniteNumber(entry.input_cost_per_token_above_128k_tokens) ||
		isFiniteNumber(entry.output_cost_per_token_above_128k_tokens)
	) {
		pricing.longContextThresholdTokens = 128_000;
	} else if (
		isFiniteNumber(entry.input_cost_per_token_above_200k_tokens) ||
		isFiniteNumber(entry.output_cost_per_token_above_200k_tokens)
	) {
		pricing.longContextThresholdTokens = 200_000;
	}

	return pricing;
}

function extractPricing(entry: LiteLLMModelEntry): ModelPricing | undefined {
	return extractLiteLLMPricing(entry);
}

function firstFinite(...values: Array<number | undefined>): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function isFiniteNumber(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
