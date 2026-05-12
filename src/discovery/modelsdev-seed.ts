/**
 * kosha-discovery — models.dev public-catalog seed.
 *
 * Translates the keyless models.dev catalog into normalized {@link ModelCard}
 * arrays per kosha provider. Same defensive posture as the LiteLLM seed:
 * strict ID charset, length cap, model-count cap, no spreading of arbitrary
 * fields into ModelCard.
 *
 * models.dev publishes pricing already in per-million-tokens, so the
 * conversion done by the LiteLLM seed is unnecessary here.
 * @module
 */

import type { ModelCard, ModelMode, ModelPricing } from "../types.js";
import { applyFreeTierFlag } from "./free-tier.js";
import {
	type ModelsDevModel,
	type ModelsDevProvider,
	loadModelsDevCatalog,
} from "./modelsdev-catalog.js";

/** Maximum models seeded for a single provider. */
const MAX_MODELS_PER_SEED = 1_000;

/** Strict charset for model IDs. */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/** Maximum length we accept for a model ID. */
const MAX_ID_LENGTH = 256;

/**
 * Map kosha provider IDs to models.dev provider slugs.
 *
 * Several models.dev slugs differ from kosha's canonical ones (`togetherai`,
 * `fireworks-ai`, `moonshotai`, etc.); aliasing here avoids polluting each
 * discoverer with the same translation logic.
 */
const PROVIDER_SLUG_ALIASES: Record<string, readonly string[]> = {
	anthropic: ["anthropic"],
	openai: ["openai"],
	google: ["google"],
	deepseek: ["deepseek"],
	zai: ["zai"],
	minimax: ["minimax"],
	moonshot: ["moonshotai", "moonshotai-cn"],
	mistral: ["mistral"],
	cohere: ["cohere"],
	groq: ["groq"],
	together: ["togetherai"],
	fireworks: ["fireworks-ai"],
	perplexity: ["perplexity"],
	cerebras: ["cerebras"],
	deepinfra: ["deepinfra"],
	xai: ["xai"],
	nvidia: ["nvidia"],
	vertex: ["google-vertex", "google-vertex-anthropic"],
	bedrock: ["amazon-bedrock"],
};

/**
 * Build seed {@link ModelCard}s for the given kosha provider, sourced from
 * models.dev. Returns `[]` if the provider has no entries.
 */
export async function getModelsDevSeed(providerId: string): Promise<ModelCard[]> {
	const slugs = PROVIDER_SLUG_ALIASES[providerId];
	if (!slugs || slugs.length === 0) return [];

	const catalog = await loadModelsDevCatalog();
	const seeds: ModelCard[] = [];
	const seenIds = new Set<string>();

	for (const slug of slugs) {
		const provider: ModelsDevProvider | undefined = catalog[slug];
		if (!provider || typeof provider !== "object") continue;
		const models = provider.models;
		if (!models || typeof models !== "object") continue;

		for (const [rawId, entry] of Object.entries(models)) {
			if (seeds.length >= MAX_MODELS_PER_SEED) break;
			if (!entry || typeof entry !== "object") continue;

			const id = sanitiseId(rawId);
			if (!id || seenIds.has(id)) continue;
			seenIds.add(id);

			const card = buildSeedCard(id, providerId, entry);
			if (card) seeds.push(card);
		}
	}

	return seeds;
}

/**
 * Validate and clean an incoming model ID. Returns null if the ID violates
 * length or charset rules so a hostile catalog cannot smuggle injection
 * shapes through.
 */
function sanitiseId(rawId: string): string | null {
	if (typeof rawId !== "string" || rawId.length === 0 || rawId.length > MAX_ID_LENGTH) {
		return null;
	}
	// Drop deployment suffix (e.g. `claude-opus-4-7@default`).
	const at = rawId.indexOf("@");
	const id = at > 0 ? rawId.slice(0, at) : rawId;
	if (!SAFE_ID_PATTERN.test(id)) return null;
	return id;
}

/** Convert a single models.dev entry into a ModelCard. */
function buildSeedCard(id: string, providerId: string, entry: ModelsDevModel): ModelCard | null {
	const mode = inferMode(entry);
	const capabilities = inferCapabilities(entry, mode);
	const pricing = extractPricing(entry);

	const contextWindow = pickPositive(entry.limit?.context) ?? 0;
	const maxOutputTokens = pickPositive(entry.limit?.output) ?? 0;
	const maxInputTokens = pickPositive(entry.limit?.input);

	const card: ModelCard = {
		id,
		name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id,
		provider: providerId,
		originProvider: providerId,
		mode,
		capabilities,
		rawCapabilities: [...capabilities],
		contextWindow,
		maxOutputTokens,
		maxInputTokens,
		pricing,
		aliases: [],
		discoveredAt: Date.now(),
		// Tagged as litellm in the ModelCard.source union for downstream
		// stability — kosha consumers only need to know "came from a public
		// community catalog" vs "came from a live API".
		source: "litellm",
	};
	return applyFreeTierFlag(card);
}

function pickPositive(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Map models.dev modality flags to a kosha ModelMode. */
function inferMode(entry: ModelsDevModel): ModelMode {
	const inputs = entry.modalities?.input ?? [];
	const outputs = entry.modalities?.output ?? [];

	if (outputs.includes("audio") && !outputs.includes("text")) return "audio";
	if (outputs.includes("video") && !outputs.includes("text")) return "video";
	if (outputs.includes("image") && !outputs.includes("text")) return "image";
	if (outputs.includes("embedding") || (Array.isArray(outputs) && outputs.length === 0 && inputs.includes("text"))) {
		// Heuristic: if there is no text *output* declared but text input,
		// treat as embedding (rare in models.dev). Default below covers chat.
		return "embedding";
	}
	if (entry.id.toLowerCase().includes("embed")) return "embedding";
	return "chat";
}

/** Build kosha capability flags from models.dev structured booleans. */
function inferCapabilities(entry: ModelsDevModel, mode: ModelMode): string[] {
	if (mode === "embedding") return ["embedding"];
	if (mode === "image") return ["image_generation"];
	if (mode === "video") return ["video_generation"];
	if (mode === "audio") return ["audio"];

	const caps = new Set<string>(["chat"]);
	const inputs = entry.modalities?.input ?? [];

	if (inputs.includes("image") || inputs.includes("pdf") || entry.attachment) caps.add("vision");
	if (entry.tool_call) caps.add("function_calling");
	if (entry.reasoning) caps.add("reasoning");
	if (entry.structured_output) caps.add("structured_output");
	if (entry.cost?.cache_read !== undefined || entry.cost?.cache_write !== undefined) {
		caps.add("prompt_caching");
	}
	caps.add("code");
	caps.add("nlu");
	return Array.from(caps);
}

/** Translate models.dev cost block into kosha ModelPricing. */
function extractPricing(entry: ModelsDevModel): ModelPricing | undefined {
	const cost = entry.cost;
	if (!cost) return undefined;

	const hasSignal =
		isFiniteNumber(cost.input) ||
		isFiniteNumber(cost.output) ||
		isFiniteNumber(cost.cache_read) ||
		isFiniteNumber(cost.cache_write) ||
		isFiniteNumber(cost.batch?.input) ||
		isFiniteNumber(cost.batch?.output);
	if (!hasSignal) return undefined;

	const pricing: ModelPricing = {
		inputPerMillion: cost.input ?? 0,
		outputPerMillion: cost.output ?? 0,
	};
	if (isFiniteNumber(cost.cache_read)) pricing.cacheReadPerMillion = cost.cache_read;
	if (isFiniteNumber(cost.cache_write)) pricing.cacheWritePerMillion = cost.cache_write;
	if (isFiniteNumber(cost.batch?.input)) pricing.batchInputPerMillion = cost.batch.input;
	if (isFiniteNumber(cost.batch?.output)) pricing.batchOutputPerMillion = cost.batch.output;
	return pricing;
}

function isFiniteNumber(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
