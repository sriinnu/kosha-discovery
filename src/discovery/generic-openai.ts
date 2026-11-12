/**
 * kosha-discovery — Spec-driven OpenAI-compatible discoverer.
 *
 * Most providers that speak the OpenAI wire format differ only in four ways:
 * the base URL, the model-list path, how origin is read off a model ID, and
 * which IDs are worth keeping. Writing a class per provider for that is
 * ceremony — {@link GenericOpenAICompatibleDiscoverer} takes those four
 * differences as data so a new provider is one entry in
 * {@link GENERIC_OPENAI_PROVIDERS} plus one entry in `PROVIDER_CATALOG`.
 *
 * Providers whose classification is genuinely non-trivial (OpenRouter's
 * per-route pricing, Groq's flat IDs plus context windows, Vercel's origin
 * remapping) keep their own hand-written discoverers. This module is for the
 * long tail, which is where most new providers land.
 * @module
 */

import { SUBSCRIPTION_PLANS } from "../subscription-plans.js";
import type { CredentialResult, ModelCard, ModelMode } from "../types.js";
import { SUBSCRIPTION_PLAN_CAPABILITY } from "./free-tier.js";
import {
	type ModelClassification,
	OpenAICompatibleDiscoverer,
	type OpenAICompatibleModel,
} from "./openai-compatible.js";
import { getPublicSeed } from "./public-seed.js";
import type { StaticModelSeed } from "./static-direct.js";
import { STATIC_XAI_MODELS } from "./static-direct.js";

/**
 * Everything that distinguishes one OpenAI-compatible provider from another.
 */
export interface OpenAICompatibleProviderSpec {
	/** Canonical provider ID; must match a `PROVIDER_CATALOG` entry. */
	providerId: string;
	/** Display name used in errors and provider listings. */
	providerName: string;
	/**
	 * Base URL up to (but excluding) the model-list path. May already carry a
	 * version segment — the endpoint chain tries `/models` before `/v1/models`,
	 * so both `https://api.x.ai/v1` and `https://api.example.com` work.
	 */
	baseUrl: string;
	/**
	 * Explicit, ordered model-list URLs. Set this when the list endpoint does
	 * not sit directly under {@link baseUrl} (Upstage serves `/v1/models` while
	 * inference lives at `/v1/solar`).
	 */
	modelListUrls?: readonly string[];
	/**
	 * True when the provider publishes no model-list endpoint. Discovery then
	 * reports the public catalog seed instead of failing — the models are real,
	 * the provider just doesn't enumerate them over HTTP.
	 */
	seedOnly?: boolean;
	/** True when IDs are `vendor/model` namespaced (`deepseek-ai/DeepSeek-V3`). */
	namespacedIds?: boolean;
	/** Lowercased ID prefix → canonical kosha origin provider. */
	originAliases?: Readonly<Record<string, string>>;
	/** Keyword → origin rules for flat IDs. Most specific first. */
	originRules?: ReadonlyArray<readonly [string, string]>;
	/**
	 * Origin for a flat ID no rule matches. Defaults to the provider ID, which
	 * is wrong for a reseller-shaped provider such as a subscription plan.
	 */
	defaultOrigin?: string;
	/** Keyword → mode overrides applied before the built-in heuristics. */
	modeRules?: ReadonlyArray<readonly [string, ModelMode]>;
	/** Substrings that disqualify a model ID entirely. */
	excludePatterns?: readonly string[];
	/**
	 * True for a subscription plan: the plan pays for tokens, so a live card
	 * carries no per-token price, is tagged plan-billed, and takes its limits
	 * from the plan's own catalog entry (the plan's model list has none).
	 */
	subscriptionPlan?: boolean;
	/** `x-api-key` for an Anthropic-style model list (MiniMax's plan host). */
	listAuth?: "x-api-key";
	/** Capability tags added to every chat model this provider serves. */
	chatCapabilities?: readonly string[];
	/**
	 * Last-resort curated models, used only when there is no credential *and*
	 * both public catalogs are unreachable. Worth setting for providers whose
	 * IDs the built-in aliases point at.
	 */
	staticSeeds?: readonly StaticModelSeed[];
}

/**
 * A plan could not test a key borrowed from a shared env var (no list route).
 * Not a rejection: the key may well work elsewhere in its family.
 */
export class PlanKeyUnverifiedError extends Error {
	constructor(providerName: string) {
		super(`${providerName}: no model list to test a shared key against`);
		this.name = "PlanKeyUnverifiedError";
	}
}

/**
 * A provider discoverer built from an {@link OpenAICompatibleProviderSpec}.
 */
export class GenericOpenAICompatibleDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId: string;
	readonly providerName: string;
	readonly baseUrl: string;

	private readonly spec: OpenAICompatibleProviderSpec;

	constructor(spec: OpenAICompatibleProviderSpec, baseUrlOverride?: string) {
		super();
		this.spec = spec;
		this.providerId = spec.providerId;
		this.providerName = spec.providerName;
		this.baseUrl = baseUrlOverride ?? spec.baseUrl;
	}

	/**
	 * Seed-only providers never hit the network for a list, and a keyless run
	 * falls back through the public catalogs to the curated seeds. Everything
	 * else defers to the shared OpenAI-compatible pipeline, whose errors stay
	 * visible in `discoveryErrors()` rather than being masked by a fallback.
	 */
	override async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const hasKey = Boolean(credential.apiKey ?? credential.accessToken);
		if (this.spec.seedOnly || !hasKey) {
			return this.keylessModels();
		}
		if (!this.spec.subscriptionPlan) return super.discover(credential, options);
		let live: ModelCard[];
		try {
			live = await super.discover(credential, options);
		} catch (error) {
			// No list route and no catalog to fall back on: still not a verdict
			// on a borrowed key.
			if (credential.shared && error instanceof Error && /API error:\s*404\b/.test(error.message)) {
				throw new PlanKeyUnverifiedError(this.providerName);
			}
			throw error;
		}
		// No list route answered, so the shared pipeline fell back to the
		// catalog. That proves nothing about a key borrowed from a shared env
		// var, and claiming it would list a plan the user may not have.
		if (credential.shared && !live.some((card) => card.source === "api")) {
			throw new PlanKeyUnverifiedError(this.providerName);
		}
		return this.asPlanCards(live);
	}

	protected override listHeaders(apiKey: string): Record<string, string> {
		if (this.spec.listAuth === "x-api-key") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
		return super.listHeaders(apiKey);
	}

	/**
	 * Tag live plan cards as plan-billed and fill their limits from the plan's
	 * catalog entry by ID. A model the catalog doesn't know yet (a preview out
	 * a day) keeps its live card, untagged limits and all.
	 */
	private async asPlanCards(live: ModelCard[]): Promise<ModelCard[]> {
		let seeds: ModelCard[] = [];
		try {
			seeds = await getPublicSeed(this.providerId);
		} catch {
			/* limits stay unknown; the listing itself is still right */
		}
		const byId = new Map(seeds.map((seed) => [seed.id, seed]));
		return live.map((card) => {
			const seed = byId.get(card.id);
			const raw = card.rawCapabilities ?? card.capabilities;
			const { pricing: _perToken, ...rest } = card;
			return {
				...rest,
				name: seed?.name ?? card.name,
				contextWindow: card.contextWindow || seed?.contextWindow || 0,
				maxOutputTokens: card.maxOutputTokens || seed?.maxOutputTokens || 0,
				...(card.maxInputTokens === undefined && seed?.maxInputTokens ? { maxInputTokens: seed.maxInputTokens } : {}),
				...(card.releaseDate === undefined && seed?.releaseDate ? { releaseDate: seed.releaseDate } : {}),
				rawCapabilities: raw.includes(SUBSCRIPTION_PLAN_CAPABILITY) ? raw : [...raw, SUBSCRIPTION_PLAN_CAPABILITY],
			};
		});
	}

	/** Public catalog seed, falling back to the curated list. */
	private async keylessModels(): Promise<ModelCard[]> {
		try {
			const seeds = await getPublicSeed(this.providerId);
			if (seeds.length > 0) return seeds;
		} catch {
			/* fall through to the curated list */
		}
		return (this.spec.staticSeeds ?? []).map((model) =>
			this.makeCard({
				id: model.id,
				name: model.name,
				provider: this.providerId,
				mode: model.mode,
				capabilities: [...model.capabilities],
				contextWindow: model.contextWindow ?? 0,
				maxOutputTokens: model.maxOutputTokens ?? 0,
				maxInputTokens: model.maxInputTokens,
				source: "manual",
			}),
		);
	}

	/**
	 * Try `/models` under the configured base first, then `/v1/models`, so a
	 * base URL that already ends in a version segment resolves in one hop and
	 * one that does not still resolves on the second.
	 */
	protected override modelListEndpoints(): string[] {
		if (this.spec.modelListUrls && this.spec.modelListUrls.length > 0) {
			return [...this.spec.modelListUrls];
		}
		return [`${this.baseUrl}/models`, `${this.baseUrl}/v1/models`];
	}

	protected override isRelevantModel(model: OpenAICompatibleModel): boolean {
		const lower = model.id.toLowerCase();
		if (this.looksLikeReward(lower)) return false;
		if (lower.includes("ft:") || lower.includes(":ft-")) return false;
		return !(this.spec.excludePatterns ?? []).some((pattern) => lower.includes(pattern));
	}

	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const lower = model.id.toLowerCase();
		const mode = this.resolveMode(lower);

		return {
			originProvider: this.resolveOrigin(model.id, lower),
			mode,
			capabilities: this.resolveCapabilities(lower, mode),
			contextWindow: model.context_window,
			maxOutputTokens: model.max_output_tokens,
			maxInputTokens: model.max_input_tokens,
			dimensions: model.output_vector_size,
		};
	}

	/** Namespaced IDs carry their origin as a prefix; flat IDs need keywords. */
	private resolveOrigin(id: string, lower: string): string {
		if (this.spec.namespacedIds) {
			return this.extractPrefixOrigin(id, this.providerId, this.spec.originAliases as Record<string, string>);
		}
		return this.inferOriginFromKeywords(
			lower,
			[...(this.spec.originRules ?? [])] as [string, string][],
			this.spec.defaultOrigin ?? this.providerId,
		);
	}

	/** Spec rules win over the shared heuristics; chat is the fallback. */
	private resolveMode(lower: string): ModelMode {
		for (const [keyword, mode] of this.spec.modeRules ?? []) {
			if (lower.includes(keyword)) return mode;
		}
		if (lower.includes("rerank")) return "rerank";
		if (this.looksLikeEmbedding(lower)) return "embedding";
		if (this.looksLikeAudio(lower)) return "audio";
		return "chat";
	}

	private resolveCapabilities(lower: string, mode: ModelMode): string[] {
		switch (mode) {
			case "embedding":
				return ["embedding"];
			case "rerank":
				return ["rerank"];
			case "image":
				return ["image_generation"];
			case "video":
				return ["video_generation"];
			case "audio":
				if (lower.includes("whisper") || lower.includes("stt") || lower.includes("transcribe")) {
					return ["speech_to_text"];
				}
				if (lower.includes("tts") || lower.includes("speech")) return ["text_to_speech"];
				return ["audio"];
			case "moderation":
				return ["moderation"];
			default:
				break;
		}

		const caps = new Set<string>(["chat", ...(this.spec.chatCapabilities ?? ["function_calling"])]);
		if (this.looksLikeVision(lower)) caps.add("vision");
		if (this.looksLikeCode(lower)) caps.add("code");
		if (lower.includes("guard") || lower.includes("moderation")) {
			caps.add("moderation");
			caps.delete("function_calling");
		}
		return [...caps];
	}
}

/**
 * Origin prefixes seen across the model-hosting providers. Keys are matched
 * lowercased, so `deepseek-ai/DeepSeek-V3` and `zai-org/GLM-5.2` both land on
 * the same canonical origin kosha uses everywhere else.
 */
const SHARED_ORIGIN_ALIASES: Readonly<Record<string, string>> = {
	"deepseek-ai": "deepseek",
	"zai-org": "zai",
	"meta-llama": "meta",
	mistralai: "mistral",
	moonshotai: "moonshot",
	"stepfun-ai": "stepfun",
	minimaxai: "minimax",
	qwen: "qwen",
	inclusionai: "inclusionai",
	thinkingmachines: "thinkingmachines",
	paddlepaddle: "baidu",
	"x-ai": "xai",
};

/** Keyword → origin rules shared by providers that serve flat open-weight IDs. */
const OPEN_WEIGHT_ORIGIN_RULES: ReadonlyArray<readonly [string, string]> = [
	["deepseek", "deepseek"],
	["nemotron", "nvidia"],
	["kimi", "moonshot"],
	["minimax", "minimax"],
	["glm", "zai"],
	["gpt-oss", "openai"],
	["gemma", "google"],
	["qwen", "qwen"],
	["mixtral", "mistral"],
	["mistral", "mistral"],
	["llama", "meta"],
];

/**
 * Model families plans resell, keyword → origin. Most specific first; a model
 * no rule names is the plan vendor's own (`defaultOrigin`).
 */
const PLAN_ORIGIN_RULES: ReadonlyArray<readonly [string, string]> = [
	["deepseek", "deepseek"],
	["glm", "zai"],
	["kimi", "moonshot"],
	["minimax", "minimax"],
	["qwen", "qwen"],
	["mimo", "xiaomi"],
	["hunyuan", "tencent"],
	["doubao", "bytedance"],
	["step-", "stepfun"],
];

const PLAN_MODE_RULES: ReadonlyArray<readonly [string, ModelMode]> = [
	["-image", "image"],
	["-video", "video"],
	["2v", "video"],
	["tts", "audio"],
	["asr", "audio"],
	["realtime", "audio"],
	["wan", "video"],
];

/** One generic spec per plan in {@link SUBSCRIPTION_PLANS}. */
const PLAN_SPECS: readonly OpenAICompatibleProviderSpec[] = SUBSCRIPTION_PLANS.map((plan) => ({
	providerId: plan.providerId,
	providerName: plan.name,
	baseUrl: plan.baseUrl,
	seedOnly: plan.listing === "none",
	originRules: PLAN_ORIGIN_RULES,
	defaultOrigin: plan.defaultOrigin,
	modeRules: PLAN_MODE_RULES,
	subscriptionPlan: true,
	...(plan.wire === "anthropic" ? { listAuth: "x-api-key" as const } : {}),
	chatCapabilities: ["function_calling", "code", "nlu"],
}));

/**
 * Every provider kosha discovers through the generic OpenAI-compatible path.
 *
 * Adding a provider here plus a `PROVIDER_CATALOG` descriptor is the whole
 * change — credentials resolve from the descriptor's `credentialEnvVars` and
 * keyless discovery resolves from the public catalog seeds.
 */
export const GENERIC_OPENAI_PROVIDERS: readonly OpenAICompatibleProviderSpec[] = [
	{
		providerId: "xai",
		providerName: "xAI",
		baseUrl: "https://api.x.ai/v1",
		// Grok Imagine serves image and video from the same model list.
		modeRules: [
			["imagine-video", "video"],
			["imagine-image", "image"],
			["-video", "video"],
			["-image", "image"],
		],
		chatCapabilities: ["function_calling", "code", "nlu"],
		staticSeeds: STATIC_XAI_MODELS,
	},
	{
		providerId: "alibaba",
		providerName: "Alibaba Model Studio (Qwen)",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		originRules: [
			["deepseek", "deepseek"],
			["qwen", "qwen"],
		],
		modeRules: [
			["-ocr", "image"],
			["wan", "video"],
		],
		chatCapabilities: ["function_calling", "code", "nlu"],
	},
	{
		// Same catalogue as `alibaba`, billed on the China price sheet — the
		// same model can cost less than half the international rate, so the two
		// regions stay separate providers rather than one merged listing.
		providerId: "alibaba-cn",
		providerName: "Alibaba Model Studio (Qwen, China)",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		originRules: [
			["deepseek", "deepseek"],
			["qwen", "qwen"],
		],
		modeRules: [
			["-ocr", "image"],
			["wan", "video"],
		],
		chatCapabilities: ["function_calling", "code", "nlu"],
	},
	...PLAN_SPECS,
	{
		providerId: "siliconflow-cn",
		providerName: "SiliconFlow (China)",
		baseUrl: "https://api.siliconflow.cn/v1",
		namespacedIds: true,
		originAliases: SHARED_ORIGIN_ALIASES,
		chatCapabilities: ["function_calling"],
	},
	{
		providerId: "stepfun",
		providerName: "StepFun",
		baseUrl: "https://api.stepfun.ai/v1",
		modeRules: [
			["tts", "audio"],
			["asr", "audio"],
			["-image", "image"],
		],
		chatCapabilities: ["function_calling", "nlu"],
	},
	{
		providerId: "stepfun-cn",
		providerName: "StepFun (China)",
		baseUrl: "https://api.stepfun.com/v1",
		modeRules: [
			["tts", "audio"],
			["asr", "audio"],
			["-image", "image"],
		],
		chatCapabilities: ["function_calling", "nlu"],
	},
	{
		providerId: "volcengine",
		providerName: "Volcengine Ark (Doubao)",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		originRules: [
			["deepseek", "deepseek"],
			["doubao", "bytedance"],
		],
		chatCapabilities: ["function_calling", "nlu"],
	},
	{
		providerId: "inception",
		providerName: "Inception Labs (Mercury)",
		baseUrl: "https://api.inceptionlabs.ai/v1",
		chatCapabilities: ["function_calling", "code"],
	},
	{
		providerId: "ai21",
		providerName: "AI21 Labs",
		baseUrl: "https://api.ai21.com/studio/v1",
		chatCapabilities: ["function_calling", "nlu"],
	},
	{
		providerId: "upstage",
		providerName: "Upstage (Solar)",
		baseUrl: "https://api.upstage.ai/v1/solar",
		// Inference is namespaced under /v1/solar; the catalog is not.
		modelListUrls: ["https://api.upstage.ai/v1/models", "https://api.upstage.ai/v1/solar/models"],
		chatCapabilities: ["function_calling", "nlu"],
	},
	{
		providerId: "meta",
		providerName: "Meta (Muse Spark)",
		baseUrl: "https://api.meta.ai/v1",
		modeRules: [
			["muse-image", "image"],
			["transcribe", "audio"],
		],
		chatCapabilities: ["function_calling", "code", "nlu"],
	},
	{
		providerId: "baseten",
		providerName: "Baseten",
		baseUrl: "https://inference.baseten.co/v1",
		namespacedIds: true,
		originAliases: SHARED_ORIGIN_ALIASES,
		chatCapabilities: ["function_calling"],
	},
	{
		providerId: "nebius",
		providerName: "Nebius Token Factory",
		baseUrl: "https://api.tokenfactory.nebius.com/v1",
		namespacedIds: true,
		originAliases: SHARED_ORIGIN_ALIASES,
		chatCapabilities: ["function_calling"],
	},
	{
		providerId: "novita",
		providerName: "Novita AI",
		baseUrl: "https://api.novita.ai/openai",
		namespacedIds: true,
		originAliases: SHARED_ORIGIN_ALIASES,
		chatCapabilities: ["function_calling"],
	},
	{
		providerId: "siliconflow",
		providerName: "SiliconFlow",
		baseUrl: "https://api.siliconflow.com/v1",
		namespacedIds: true,
		originAliases: SHARED_ORIGIN_ALIASES,
		chatCapabilities: ["function_calling"],
	},
	{
		providerId: "huggingface",
		providerName: "Hugging Face Inference Providers",
		baseUrl: "https://router.huggingface.co/v1",
		namespacedIds: true,
		originAliases: SHARED_ORIGIN_ALIASES,
		chatCapabilities: ["function_calling"],
	},
	{
		providerId: "ollama-cloud",
		providerName: "Ollama Cloud",
		baseUrl: "https://ollama.com/v1",
		originRules: OPEN_WEIGHT_ORIGIN_RULES,
		chatCapabilities: ["function_calling"],
	},
	{
		providerId: "thinkingmachines",
		providerName: "Thinking Machines",
		// Tinker exposes an Anthropic-wire inference endpoint and no model list,
		// so the public catalog is the only enumeration available.
		baseUrl: "https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1",
		seedOnly: true,
		namespacedIds: true,
		originAliases: SHARED_ORIGIN_ALIASES,
		chatCapabilities: ["function_calling", "vision", "nlu"],
	},
] as const;

/** Look up a generic provider spec by canonical provider ID. */
export function getGenericProviderSpec(providerId: string): OpenAICompatibleProviderSpec | undefined {
	return GENERIC_OPENAI_PROVIDERS.find((spec) => spec.providerId === providerId);
}
