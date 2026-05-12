import { afterEach, describe, expect, it } from "vitest";
import { VercelAIGatewayDiscoverer } from "../../src/discovery/vercel.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, restoreFetch } from "./mock-server.js";

const discoverer = new VercelAIGatewayDiscoverer();
const API_URL = "https://ai-gateway.vercel.sh/v1/models";

const noCredential: CredentialResult = {
	source: "none",
};

const claude = {
	id: "anthropic/claude-opus-4.6",
	object: "model",
	created: 1_755_815_280,
	released: 1_770_249_600,
	owned_by: "anthropic",
	name: "Claude Opus 4.6",
	description: "Frontier coding and professional work model.",
	context_window: 1_000_000,
	max_tokens: 128_000,
	type: "language",
	tags: ["tool-use", "reasoning", "vision", "file-input", "explicit-caching", "web-search"],
	pricing: {
		input: "0.000005",
		output: "0.000025",
		input_cache_read: "0.0000005",
		input_cache_write: "0.00000625",
		web_search: "14",
	},
};

const tieredLanguage = {
	id: "alibaba/qwen-3.6-max-preview",
	object: "model",
	owned_by: "alibaba",
	name: "Qwen 3.6 Max Preview",
	context_window: 240_000,
	max_tokens: 64_000,
	type: "language",
	tags: ["tool-use", "implicit-caching", "vision"],
	pricing: {
		input_tiers: [
			{ cost: "0.0000013", min: 0, max: 128_000 },
			{ cost: "0.000002", min: 128_000 },
		],
		output_tiers: [
			{ cost: "0.0000078", min: 0, max: 128_000 },
			{ cost: "0.000012", min: 128_000 },
		],
	},
};

const embedding = {
	id: "openai/text-embedding-3-small",
	object: "model",
	owned_by: "openai",
	name: "Text Embedding 3 Small",
	context_window: 8191,
	max_tokens: 0,
	type: "embedding",
	tags: [],
	pricing: { input: "0.00000002", output: "0" },
};

const image = {
	id: "black-forest-labs/flux-pro",
	object: "model",
	owned_by: "black-forest-labs",
	name: "FLUX Pro",
	context_window: 0,
	max_tokens: 0,
	type: "image",
	tags: ["image-generation"],
	pricing: {
		image_dimension_quality_pricing: [
			{ size: "1K", cost: "0.04" },
			{ size: "4K", cost: "0.12" },
		],
	},
};

const video = {
	id: "alibaba/wan-v2.5-t2v-preview",
	object: "model",
	owned_by: "alibaba",
	name: "Wan v2.5 Text-to-Video Preview",
	context_window: 0,
	max_tokens: 0,
	type: "video",
	tags: [],
	pricing: {
		video_duration_pricing: [
			{ resolution: "480p", cost_per_second: "0.05" },
			{ resolution: "720p", cost_per_second: "0.1" },
		],
	},
};

const tokenPricedVideo = {
	id: "bytedance/seedance-2.0-fast",
	object: "model",
	owned_by: "bytedance",
	name: "Seedance 2.0 Fast",
	context_window: 0,
	max_tokens: 0,
	type: "video",
	tags: [],
	pricing: {
		video_token_pricing: {
			no_video_input: { cost_per_million_tokens: "5.6" },
			with_video_input: { cost_per_million_tokens: "3.3" },
		},
	},
};

const rerank = {
	id: "cohere/rerank-v3.5",
	object: "model",
	owned_by: "cohere",
	name: "Cohere Rerank 3.5",
	context_window: 4096,
	max_tokens: 4096,
	type: "reranking",
	tags: [],
	pricing: {},
};

afterEach(() => {
	restoreFetch();
});

describe("VercelAIGatewayDiscoverer", () => {
	it("has correct provider metadata", () => {
		expect(discoverer.providerId).toBe("vercel");
		expect(discoverer.providerName).toBe("Vercel AI Gateway");
		expect(discoverer.baseUrl).toBe("https://ai-gateway.vercel.sh/v1");
	});

	it("discovers the public model catalog without credentials", async () => {
		mockFetch({ [API_URL]: { status: 200, body: { object: "list", data: [claude] } } });

		const cards = await discoverer.discover(noCredential);
		const card = cards[0];

		expect(card.id).toBe("anthropic/claude-opus-4.6");
		expect(card.provider).toBe("vercel");
		expect(card.originProvider).toBe("anthropic");
		expect(card.mode).toBe("chat");
		expect(card.contextWindow).toBe(1_000_000);
		expect(card.maxOutputTokens).toBe(128_000);
		expect(card.capabilities).toEqual(
			expect.arrayContaining([
				"chat",
				"function_calling",
				"vision",
				"reasoning",
				"nlu",
				"file_input",
				"web_search",
				"prompt_caching",
			]),
		);
		expect(card.toolDialect).toBe("openai-tools");
		expect(card.pricing?.inputPerMillion).toBeCloseTo(5);
		expect(card.pricing?.outputPerMillion).toBeCloseTo(25);
		expect(card.pricing?.cacheReadPerMillion).toBeCloseTo(0.5);
		expect(card.pricing?.cacheWritePerMillion).toBeCloseTo(6.25);
		expect(card.pricing?.webSearchPerThousandRequests).toBeCloseTo(14);
	});

	it("sends bearer auth when an API key or OIDC token is present", async () => {
		const captured: Array<Record<string, string>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			captured.push(
				Object.fromEntries(Object.entries(init?.headers ?? {}).map(([key, value]) => [key, String(value)])),
			);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => ({ object: "list", data: [] }),
				text: async () => JSON.stringify({ object: "list", data: [] }),
			} as Response;
		}) as typeof globalThis.fetch;

		try {
			await discoverer.discover({ apiKey: "ai-gateway-key", source: "env" });
			await discoverer.discover({ accessToken: "oidc-token", source: "env" });
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(captured[0].Authorization).toBe("Bearer ai-gateway-key");
		expect(captured[1].Authorization).toBe("Bearer oidc-token");
	});

	it("maps non-chat modes and unit pricing", async () => {
		mockFetch({
			[API_URL]: {
				status: 200,
				body: { object: "list", data: [embedding, image, video, tokenPricedVideo, rerank] },
			},
		});

		const cards = await discoverer.discover(noCredential);

		expect(cards.find((card) => card.id === embedding.id)).toMatchObject({
			mode: "embedding",
			capabilities: ["embedding"],
			toolDialect: "none",
		});
		expect(cards.find((card) => card.id === image.id)).toMatchObject({
			mode: "image",
			capabilities: ["image_generation"],
			pricing: { imageOutputPerImage: 0.04 },
			toolDialect: "none",
		});
		expect(cards.find((card) => card.id === video.id)).toMatchObject({
			mode: "video",
			capabilities: ["video_generation"],
			pricing: { videoOutputPerSecond: 0.05 },
			toolDialect: "none",
		});
		expect(cards.find((card) => card.id === tokenPricedVideo.id)).toMatchObject({
			mode: "video",
			capabilities: ["video_generation"],
			pricing: { outputPerMillion: 5.6, videoInputPerMillion: 3.3 },
			toolDialect: "none",
		});
		expect(cards.find((card) => card.id === rerank.id)).toMatchObject({
			mode: "rerank",
			capabilities: ["rerank"],
			pricing: undefined,
			toolDialect: "none",
		});
	});

	it("parses tiered pricing and long-context thresholds", async () => {
		mockFetch({ [API_URL]: { status: 200, body: { object: "list", data: [tieredLanguage] } } });

		const cards = await discoverer.discover(noCredential);
		const pricing = cards[0].pricing;

		expect(pricing?.inputPerMillion).toBeCloseTo(1.3);
		expect(pricing?.outputPerMillion).toBeCloseTo(7.8);
		expect(pricing?.longContextInputPerMillion).toBeCloseTo(2);
		expect(pricing?.longContextOutputPerMillion).toBeCloseTo(12);
		expect(pricing?.longContextThresholdTokens).toBe(128_000);
	});
});
