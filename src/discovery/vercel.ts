/**
 * kosha-discovery — Vercel AI Gateway discoverer.
 *
 * Vercel's AI Gateway exposes a public, OpenAI-compatible model catalog at
 * `/v1/models`. The payload is richer than a plain OpenAI model list: it
 * includes context limits, model type, tags, release metadata, and route-level
 * pricing summaries. Discovery is unauthenticated, while execution through the
 * gateway requires `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`.
 *
 * @module
 */

import type { CredentialResult, ModelCard, ModelMode, ModelPricing, ToolDialect } from "../types.js";
import { BaseDiscoverer } from "./base.js";

interface VercelPricingTier {
	cost: string;
	min: number;
	max?: number;
}

interface VercelVideoDurationPrice {
	resolution?: string;
	cost_per_second?: string;
	cost?: string;
}

interface VercelImageDimensionQualityPrice {
	size?: string;
	quality?: string;
	cost?: string;
}

interface VercelVideoTokenPrice {
	cost_per_million_tokens?: string;
}

interface VercelVideoTokenPricing {
	no_video_input?: VercelVideoTokenPrice;
	with_video_input?: VercelVideoTokenPrice;
	notes?: string;
}

interface VercelModelPricing {
	input?: string;
	output?: string;
	input_tiers?: VercelPricingTier[];
	output_tiers?: VercelPricingTier[];
	input_cache_read?: string;
	input_cache_read_tiers?: VercelPricingTier[];
	input_cache_write?: string;
	input_cache_write_tiers?: VercelPricingTier[];
	image?: string;
	image_output?: string;
	image_dimension_quality_pricing?: VercelImageDimensionQualityPrice[];
	video_duration_pricing?: VercelVideoDurationPrice[];
	video_token_pricing?: VercelVideoTokenPricing;
	web_search?: string;
	maps_search?: string;
	request?: string;
}

interface VercelModel {
	id: string;
	object: "model" | string;
	created?: number;
	released?: number;
	owned_by?: string;
	name?: string;
	description?: string;
	context_window?: number;
	max_tokens?: number;
	type?: string;
	tags?: string[];
	pricing?: VercelModelPricing;
}

interface VercelModelListResponse {
	object: "list" | string;
	data: VercelModel[];
}

const ORIGIN_ALIASES: Record<string, string> = {
	"meta-llama": "meta",
	mistralai: "mistral",
	moonshotai: "moonshot",
	"x-ai": "xai",
	"z-ai": "zai",
};

/** Discovers models available through Vercel AI Gateway. */
export class VercelAIGatewayDiscoverer extends BaseDiscoverer {
	readonly providerId = "vercel";
	readonly providerName = "Vercel AI Gateway";
	readonly baseUrl = "https://ai-gateway.vercel.sh/v1";

	/**
	 * Fetch the public Gateway model catalog.
	 *
	 * The model list currently requires no authentication. If a credential is
	 * present, I still send it so the implementation remains compatible if
	 * Vercel later applies account-scoped model visibility or rate limits.
	 */
	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const timeoutMs = this.validateTimeout(options?.timeout, 15_000);
		const token = credential.apiKey ?? credential.accessToken;
		const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

		const response = await this.fetchJSON<VercelModelListResponse>(`${this.baseUrl}/models`, headers, timeoutMs);

		return response.data.filter((model) => this.isRelevantModel(model)).map((model) => this.toModelCard(model));
	}

	private isRelevantModel(model: VercelModel): boolean {
		return typeof model.id === "string" && model.id.length > 0 && model.object === "model";
	}

	private toModelCard(model: VercelModel): ModelCard {
		const mode = this.inferMode(model);
		const capabilities = this.inferCapabilities(model, mode);

		return this.makeCard({
			id: model.id,
			name: model.name ?? model.id,
			provider: this.providerId,
			originProvider: this.extractOriginProvider(model),
			mode,
			capabilities,
			contextWindow: model.context_window ?? 0,
			maxOutputTokens: model.max_tokens ?? 0,
			pricing: this.parsePricing(model.pricing),
			toolDialect: this.inferToolDialect(mode, capabilities),
			status: this.inferStatus(model),
		});
	}

	private inferMode(model: VercelModel): ModelMode {
		switch ((model.type ?? "").toLowerCase()) {
			case "embedding":
				return "embedding";
			case "image":
				return "image";
			case "video":
				return "video";
			case "reranking":
			case "rerank":
				return "rerank";
			default:
				return "chat";
		}
	}

	private inferCapabilities(model: VercelModel, mode: ModelMode): string[] {
		if (mode === "embedding") return ["embedding"];
		if (mode === "rerank") return ["rerank"];
		if (mode === "image") return ["image_generation"];
		if (mode === "video") return ["video_generation"];

		const lowerId = model.id.toLowerCase();
		const tags = new Set((model.tags ?? []).map((tag) => tag.toLowerCase()));
		const caps = new Set<string>(["chat"]);

		if (tags.has("tool-use")) caps.add("function_calling");
		if (tags.has("vision")) caps.add("vision");
		if (tags.has("reasoning")) {
			caps.add("reasoning");
			caps.add("nlu");
		}
		if (tags.has("file-input")) caps.add("file_input");
		if (tags.has("web-search") || model.pricing?.web_search !== undefined) caps.add("web_search");
		if (model.pricing?.maps_search !== undefined) caps.add("maps_search");
		if (
			model.pricing?.image !== undefined ||
			model.pricing?.image_output !== undefined ||
			(model.pricing?.image_dimension_quality_pricing?.length ?? 0) > 0
		) {
			caps.add("image_generation");
		}
		if (tags.has("implicit-caching") || tags.has("explicit-caching")) caps.add("prompt_caching");
		if (lowerId.includes("code") || lowerId.includes("coder") || lowerId.includes("codestral")) caps.add("code");

		return [...caps];
	}

	private inferToolDialect(mode: ModelMode, capabilities: string[]): ToolDialect {
		if (mode !== "chat") return "none";
		return capabilities.includes("function_calling") ? "openai-tools" : "none";
	}

	private extractOriginProvider(model: VercelModel): string {
		const slashIdx = model.id.indexOf("/");
		const rawPrefix = slashIdx === -1 ? model.owned_by : model.id.slice(0, slashIdx);
		const prefix = rawPrefix?.toLowerCase();
		if (!prefix) return "vercel";
		return ORIGIN_ALIASES[prefix] ?? prefix;
	}

	private inferStatus(model: VercelModel): ModelCard["status"] {
		const label = `${model.id} ${model.name ?? ""}`.toLowerCase();
		if (label.includes("preview") || label.includes("beta")) return "preview";
		return "active";
	}

	private parsePricing(pricing: VercelModelPricing | undefined): ModelPricing | undefined {
		if (!pricing) return undefined;

		const inputPerMillion = this.parsePerToken(pricing.input) ?? this.firstTierPerMillion(pricing.input_tiers);
		const outputPerMillion = this.parsePerToken(pricing.output) ?? this.firstTierPerMillion(pricing.output_tiers);
		const cacheReadPerMillion =
			this.parsePerToken(pricing.input_cache_read) ?? this.firstTierPerMillion(pricing.input_cache_read_tiers);
		const cacheWritePerMillion =
			this.parsePerToken(pricing.input_cache_write) ?? this.firstTierPerMillion(pricing.input_cache_write_tiers);
		const imageOutputPerImage = this.parseImagePerOutput(pricing);
		const videoOutputPerSecond = this.parseVideoPerSecond(pricing.video_duration_pricing);
		const videoInputPerMillion = this.parseVideoTokenPerMillion(pricing.video_token_pricing?.with_video_input);
		const videoOutputTokenPerMillion = this.parseVideoTokenPerMillion(pricing.video_token_pricing?.no_video_input);
		const webSearchPerThousandRequests = this.parseDollar(pricing.web_search);
		const mapsSearchPerThousandRequests = this.parseDollar(pricing.maps_search);
		const requestPerThousand = this.parseDollar(pricing.request);

		const hasAnyPricing = [
			inputPerMillion,
			outputPerMillion,
			cacheReadPerMillion,
			cacheWritePerMillion,
			imageOutputPerImage,
			videoOutputPerSecond,
			videoInputPerMillion,
			videoOutputTokenPerMillion,
			webSearchPerThousandRequests,
			mapsSearchPerThousandRequests,
			requestPerThousand,
		].some((value) => value !== undefined);
		if (!hasAnyPricing) return undefined;

		const result: ModelPricing = {
			inputPerMillion: inputPerMillion ?? 0,
			outputPerMillion: outputPerMillion ?? videoOutputTokenPerMillion ?? 0,
		};

		if (cacheReadPerMillion !== undefined) result.cacheReadPerMillion = cacheReadPerMillion;
		if (cacheWritePerMillion !== undefined) result.cacheWritePerMillion = cacheWritePerMillion;
		if (imageOutputPerImage !== undefined) result.imageOutputPerImage = imageOutputPerImage;
		if (videoOutputPerSecond !== undefined) result.videoOutputPerSecond = videoOutputPerSecond;
		if (videoInputPerMillion !== undefined) result.videoInputPerMillion = videoInputPerMillion;
		if (webSearchPerThousandRequests !== undefined) result.webSearchPerThousandRequests = webSearchPerThousandRequests;
		if (mapsSearchPerThousandRequests !== undefined) result.mapsSearchPerThousandRequests = mapsSearchPerThousandRequests;
		if (requestPerThousand !== undefined) result.requestPerThousand = requestPerThousand;

		const longInput = this.longTier(pricing.input_tiers);
		const longOutput = this.longTier(pricing.output_tiers);
		const threshold = longInput?.min ?? longOutput?.min;
		if (longInput) result.longContextInputPerMillion = longInput.costPerMillion;
		if (longOutput) result.longContextOutputPerMillion = longOutput.costPerMillion;
		if (threshold !== undefined) result.longContextThresholdTokens = threshold;

		return result;
	}

	private parsePerToken(value: string | undefined): number | undefined {
		const parsed = this.parseDollar(value);
		return parsed === undefined ? undefined : parsed * 1_000_000;
	}

	private firstTierPerMillion(tiers: VercelPricingTier[] | undefined): number | undefined {
		return this.parsePerToken(tiers?.[0]?.cost);
	}

	private longTier(tiers: VercelPricingTier[] | undefined): { min: number; costPerMillion: number } | undefined {
		const tier = tiers?.find((entry) => entry.min > 0);
		const costPerMillion = this.parsePerToken(tier?.cost);
		return tier && costPerMillion !== undefined ? { min: tier.min, costPerMillion } : undefined;
	}

	private parseDollar(value: string | undefined): number | undefined {
		if (value === undefined || value === "") return undefined;
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private parseImagePerOutput(pricing: VercelModelPricing): number | undefined {
		const flat = this.parseDollar(pricing.image_output) ?? this.parseDollar(pricing.image);
		const dimensionPrices = pricing.image_dimension_quality_pricing
			?.map((entry) => this.parseDollar(entry.cost))
			.filter((value): value is number => value !== undefined) ?? [];
		const allPrices = flat === undefined ? dimensionPrices : [flat, ...dimensionPrices];
		if (allPrices.length === 0) return undefined;
		return Math.min(...allPrices);
	}

	private parseVideoPerSecond(pricing: VercelVideoDurationPrice[] | undefined): number | undefined {
		if (!pricing || pricing.length === 0) return undefined;
		const values = pricing
			.map((entry) => this.parseDollar(entry.cost_per_second ?? entry.cost))
			.filter((value): value is number => value !== undefined);
		if (values.length === 0) return undefined;
		return Math.min(...values);
	}

	private parseVideoTokenPerMillion(pricing: VercelVideoTokenPrice | undefined): number | undefined {
		return this.parseDollar(pricing?.cost_per_million_tokens);
	}
}
