/**
 * kosha-discovery — Subscription plans ("token plans", "coding plans").
 *
 * A plan is a flat subscription served from its own host: the plan pays for
 * the tokens, so its models carry no per-token price, and it often serves
 * models pay-as-you-go never lists (Alibaba's `qwen4-max-preview` shipped on
 * Token Plan first). Each plan-region is its own provider, because the proxy
 * resolves host, credential and allowlist per provider.
 *
 * This table is the single source: the provider catalog, the discoverer
 * registry and the models.dev seed mapping are all generated from it. The
 * `providerId` is the models.dev slug, so keyless data lines up by itself.
 *
 * A plan is listed only when a key resolves for it; without one its models
 * stay price-only rows in `catalog-only.json`, as before.
 * @module
 */

/** How a plan's model list behaves, which decides how far it can be trusted. */
export type PlanListing =
	/** `/models` needs a key and rejects a wrong one: a 200 proves the key. */
	| "validates"
	/** `/models` answers without a key: a 200 proves nothing about it. */
	| "open"
	/** No list route: models come from the catalog, unverified. */
	| "none";

export interface SubscriptionPlan {
	/** Provider ID; equal to the models.dev slug. */
	providerId: string;
	name: string;
	/** Vendor family, for grouping and for the key-refusal warning. */
	family: string;
	/** Base URL up to the model-list / chat-completions paths. */
	baseUrl: string;
	/** Env vars only this plan reads. A key here is meant for this plan. */
	dedicatedEnvVars: string[];
	/**
	 * Env vars the family's other providers also read. A key found here is
	 * tentative: the plan tries it, keeps it on a 200, and drops it quietly
	 * on a 401. Only plans whose list `validates` can test a key, so the
	 * others leave this empty.
	 */
	sharedEnvVars: string[];
	/** Every key this vendor issues for the plan starts with this. */
	keyPrefix?: string;
	listing: PlanListing;
	/** `anthropic` when the plan speaks the Messages wire. */
	wire?: "anthropic";
	/** Messages path for an `anthropic` wire. */
	anthropicMessagesPath?: string;
	/** Origin for a model ID no keyword names (the vendor's own models). */
	defaultOrigin: string;
	aliases?: string[];
}

/** Shared env vars of Alibaba's pay-as-you-go international region. */
const ALIBABA_INTL_VARS = ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY", "QWEN_API_KEY"];

/** Alibaba issues `sk-sp-` keys for both Token Plan and Coding Plan. */
export const ALIBABA_PLAN_KEY_PREFIX = "sk-sp-";

/** Kimi For Coding keys; verified live on both coding hosts. */
export const KIMI_CODE_KEY_PREFIX = "sk-kimi-";

export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = [
	{
		providerId: "alibaba-token-plan",
		name: "Alibaba Token Plan",
		family: "alibaba",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		dedicatedEnvVars: ["ALIBABA_TOKEN_PLAN_API_KEY"],
		sharedEnvVars: ALIBABA_INTL_VARS,
		keyPrefix: ALIBABA_PLAN_KEY_PREFIX,
		listing: "validates",
		defaultOrigin: "alibaba",
		aliases: ["token-plan", "qwen-token-plan"],
	},
	{
		// Beijing rejected a Singapore plan key live; trying the shared vars
		// here costs one request and finds a China key kept under the same name.
		providerId: "alibaba-token-plan-cn",
		name: "Alibaba Token Plan (China)",
		family: "alibaba",
		baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		dedicatedEnvVars: ["ALIBABA_TOKEN_PLAN_CN_API_KEY"],
		sharedEnvVars: ["DASHSCOPE_CN_API_KEY", ...ALIBABA_INTL_VARS],
		keyPrefix: ALIBABA_PLAN_KEY_PREFIX,
		listing: "validates",
		defaultOrigin: "alibaba",
		aliases: ["token-plan-cn", "qwen-token-plan-cn"],
	},
	{
		providerId: "alibaba-coding-plan",
		name: "Alibaba Coding Plan",
		family: "alibaba",
		baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
		dedicatedEnvVars: ["ALIBABA_CODING_PLAN_API_KEY"],
		sharedEnvVars: [],
		keyPrefix: ALIBABA_PLAN_KEY_PREFIX,
		listing: "open",
		defaultOrigin: "alibaba",
		aliases: ["coding-plan", "qwen-coding-plan"],
	},
	{
		providerId: "alibaba-coding-plan-cn",
		name: "Alibaba Coding Plan (China)",
		family: "alibaba",
		baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
		dedicatedEnvVars: ["ALIBABA_CODING_PLAN_CN_API_KEY"],
		sharedEnvVars: [],
		keyPrefix: ALIBABA_PLAN_KEY_PREFIX,
		listing: "open",
		defaultOrigin: "alibaba",
		aliases: ["coding-plan-cn", "qwen-coding-plan-cn"],
	},
	{
		providerId: "kimi-code-plan-global",
		name: "Kimi For Coding (kimi.ai)",
		family: "moonshot",
		baseUrl: "https://api.kimi.ai/coding/v1",
		dedicatedEnvVars: ["KIMI_CODE_API_KEY"],
		sharedEnvVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
		keyPrefix: KIMI_CODE_KEY_PREFIX,
		listing: "validates",
		defaultOrigin: "moonshot",
		aliases: ["kimi-code", "kimi-for-coding"],
	},
	{
		providerId: "kimi-code-plan-cn",
		name: "Kimi For Coding (kimi.com)",
		family: "moonshot",
		baseUrl: "https://api.kimi.com/coding/v1",
		dedicatedEnvVars: ["KIMI_CODE_CN_API_KEY"],
		sharedEnvVars: ["KIMI_API_KEY", "MOONSHOT_CN_API_KEY", "MOONSHOT_API_KEY"],
		keyPrefix: KIMI_CODE_KEY_PREFIX,
		listing: "validates",
		defaultOrigin: "moonshot",
		aliases: ["kimi-code-cn", "kimi-for-coding-cn"],
	},
	{
		providerId: "zai-coding-plan",
		name: "Z.AI Coding Plan",
		family: "zai",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		dedicatedEnvVars: ["ZAI_CODING_PLAN_API_KEY"],
		sharedEnvVars: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
		listing: "validates",
		defaultOrigin: "zai",
		aliases: ["glm-coding-plan"],
	},
	{
		providerId: "zhipuai-coding-plan",
		name: "Zhipu AI Coding Plan",
		family: "zai",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		dedicatedEnvVars: ["ZHIPU_CODING_PLAN_API_KEY"],
		sharedEnvVars: ["ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"],
		listing: "validates",
		defaultOrigin: "zai",
		aliases: ["glm-coding-plan-cn"],
	},
	{
		providerId: "minimax-coding-plan",
		name: "MiniMax Token Plan",
		family: "minimax",
		baseUrl: "https://api.minimax.io/anthropic/v1",
		dedicatedEnvVars: ["MINIMAX_TOKEN_PLAN_API_KEY"],
		sharedEnvVars: ["MINIMAX_API_KEY"],
		listing: "validates",
		wire: "anthropic",
		anthropicMessagesPath: "/anthropic/v1/messages",
		defaultOrigin: "minimax",
		aliases: ["minimax-token-plan"],
	},
	{
		providerId: "minimax-cn-coding-plan",
		name: "MiniMax Token Plan (China)",
		family: "minimax",
		baseUrl: "https://api.minimax.cn/anthropic/v1",
		dedicatedEnvVars: ["MINIMAX_TOKEN_PLAN_CN_API_KEY"],
		sharedEnvVars: ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY"],
		listing: "validates",
		wire: "anthropic",
		anthropicMessagesPath: "/anthropic/v1/messages",
		defaultOrigin: "minimax",
		aliases: ["minimax-token-plan-cn"],
	},
	...(
		[
			["sgp", "Singapore"],
			["cn", "China"],
			["ams", "Europe"],
		] as const
	).map(
		([region, label]): SubscriptionPlan => ({
			providerId: `xiaomi-token-plan-${region}`,
			name: `Xiaomi Token Plan (${label})`,
			family: "xiaomi",
			baseUrl: `https://token-plan-${region}.xiaomimimo.com/v1`,
			dedicatedEnvVars: [`XIAOMI_TOKEN_PLAN_${region.toUpperCase()}_API_KEY`],
			sharedEnvVars: ["XIAOMI_TOKEN_PLAN_API_KEY", "XIAOMI_API_KEY", "MIMO_API_KEY"],
			listing: "validates",
			defaultOrigin: "xiaomi",
		}),
	),
	{
		providerId: "stepfun-ai-step-plan",
		name: "StepFun Step Plan",
		family: "stepfun",
		baseUrl: "https://api.stepfun.ai/step_plan/v1",
		dedicatedEnvVars: ["STEPFUN_STEP_PLAN_API_KEY"],
		sharedEnvVars: ["STEPFUN_API_KEY"],
		listing: "validates",
		defaultOrigin: "stepfun",
		aliases: ["step-plan"],
	},
	{
		providerId: "stepfun-step-plan",
		name: "StepFun Step Plan (China)",
		family: "stepfun",
		baseUrl: "https://api.stepfun.com/step_plan/v1",
		dedicatedEnvVars: ["STEPFUN_STEP_PLAN_CN_API_KEY"],
		sharedEnvVars: ["STEPFUN_CN_API_KEY", "STEPFUN_API_KEY"],
		listing: "validates",
		defaultOrigin: "stepfun",
		aliases: ["step-plan-cn"],
	},
	{
		providerId: "tencent-coding-plan",
		name: "Tencent Coding Plan (China)",
		family: "tencent",
		baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
		dedicatedEnvVars: ["TENCENT_CODING_PLAN_API_KEY"],
		sharedEnvVars: [],
		listing: "validates",
		defaultOrigin: "tencent",
	},
	{
		providerId: "tencent-token-plan",
		name: "Tencent Token Plan",
		family: "tencent",
		baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
		dedicatedEnvVars: ["TENCENT_TOKEN_PLAN_API_KEY"],
		sharedEnvVars: [],
		listing: "validates",
		defaultOrigin: "tencent",
	},
	{
		providerId: "volcengine-coding-plan",
		name: "Volcengine Ark Coding Plan",
		family: "volcengine",
		baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
		dedicatedEnvVars: ["ARK_CODING_PLAN_API_KEY"],
		sharedEnvVars: ["ARK_API_KEY", "VOLCENGINE_API_KEY"],
		listing: "validates",
		defaultOrigin: "bytedance",
		aliases: ["ark-coding-plan", "doubao-coding-plan"],
	},
	{
		// Answers 400 without a key, so it can't be probed safely; dedicated only.
		providerId: "scnet-token-plan",
		name: "SCNet Token Plan",
		family: "scnet",
		baseUrl: "https://api.scnet.cn/api/llm/v1",
		dedicatedEnvVars: ["SCNET_API_KEY"],
		sharedEnvVars: [],
		listing: "validates",
		defaultOrigin: "scnet",
	},
	{
		providerId: "umans-ai-coding-plan",
		name: "Umans AI Coding Plan",
		family: "umans",
		baseUrl: "https://api.code.umans.ai/v1",
		dedicatedEnvVars: ["UMANS_AI_CODING_PLAN_API_KEY"],
		sharedEnvVars: [],
		listing: "open",
		defaultOrigin: "umans",
	},
	{
		providerId: "kuae-cloud-coding-plan",
		name: "KUAE Cloud Coding Plan",
		family: "kuae",
		baseUrl: "https://coding-plan-endpoint.kuaecloud.net/v1",
		dedicatedEnvVars: ["KUAE_API_KEY"],
		sharedEnvVars: [],
		listing: "none",
		defaultOrigin: "zai",
	},
];

const PLAN_BY_ID = new Map(SUBSCRIPTION_PLANS.map((plan) => [plan.providerId, plan]));

export function getSubscriptionPlan(providerId: string): SubscriptionPlan | undefined {
	return PLAN_BY_ID.get(providerId);
}

export function isSubscriptionPlanProvider(providerId: string): boolean {
	return PLAN_BY_ID.has(providerId);
}

/** Every plan key prefix a family's pay-as-you-go providers must refuse. */
export function planKeyPrefixesForFamily(family: string): string[] {
	return [
		...new Set(
			SUBSCRIPTION_PLANS.filter((plan) => plan.family === family && plan.keyPrefix).map(
				(plan) => plan.keyPrefix as string,
			),
		),
	];
}
