import { afterEach, describe, expect, it } from "vitest";
import {
	GENERIC_OPENAI_PROVIDERS,
	GenericOpenAICompatibleDiscoverer,
	getGenericProviderSpec,
} from "../../src/discovery/generic-openai.js";
import { getDiscoverer } from "../../src/discovery/index.js";
import { MiniMaxDiscoverer } from "../../src/discovery/minimax.js";
import { MoonshotDiscoverer } from "../../src/discovery/moonshot.js";
import { getProviderDescriptor } from "../../src/provider-catalog.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, restoreFetch } from "./mock-server.js";

const validCredential: CredentialResult = { apiKey: "test-api-key", source: "env" };

function listResponse(...ids: string[]) {
	return {
		status: 200,
		body: {
			object: "list",
			data: ids.map((id) => ({ id, object: "model", created: 1, owned_by: "test" })),
		},
	};
}

afterEach(() => {
	restoreFetch();
});

describe("spec-driven OpenAI-compatible providers", () => {
	it("registers every spec in the catalog and the discoverer registry", () => {
		// A spec without a catalog descriptor has no credential env vars, so it
		// would silently never authenticate.
		for (const spec of GENERIC_OPENAI_PROVIDERS) {
			const descriptor = getProviderDescriptor(spec.providerId);
			expect(descriptor, `missing catalog entry for ${spec.providerId}`).toBeDefined();
			expect(descriptor?.canonicalProviderId).toBe(spec.providerId);
			expect(getDiscoverer(spec.providerId)?.providerId).toBe(spec.providerId);
		}
	});

	it("discovers xAI models and splits Grok Imagine into image and video", async () => {
		mockFetch({ "https://api.x.ai/v1/models": listResponse("grok-4.6", "grok-imagine-image", "grok-imagine-video") });

		const cards = await getDiscoverer("xai")!.discover(validCredential);
		const byId = new Map(cards.map((card) => [card.id, card]));

		expect(byId.get("grok-4.6")?.mode).toBe("chat");
		expect(byId.get("grok-4.6")?.capabilities).toContain("function_calling");
		expect(byId.get("grok-imagine-image")?.mode).toBe("image");
		expect(byId.get("grok-imagine-video")?.mode).toBe("video");
		expect(byId.get("grok-imagine-video")?.capabilities).toEqual(["video_generation"]);
		expect(cards.every((card) => card.provider === "xai")).toBe(true);
	});

	it("maps namespaced vendor prefixes onto canonical kosha origins", async () => {
		mockFetch({
			"https://inference.baseten.co/v1/models": listResponse(
				"deepseek-ai/DeepSeek-V3.1",
				"zai-org/GLM-5.2",
				"moonshotai/Kimi-K3",
			),
		});

		const cards = await getDiscoverer("baseten")!.discover(validCredential);
		const origins = new Map(cards.map((card) => [card.id, card.originProvider]));

		// The serving layer is baseten; the origin is whoever built the model.
		expect(origins.get("deepseek-ai/DeepSeek-V3.1")).toBe("deepseek");
		expect(origins.get("zai-org/GLM-5.2")).toBe("zai");
		expect(origins.get("moonshotai/Kimi-K3")).toBe("moonshot");
		expect(cards.every((card) => card.provider === "baseten")).toBe(true);
	});

	it("tries the versioned path when the base URL carries no version segment", async () => {
		const calls: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(url);
			if (url.endsWith("/openai/models")) {
				return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
			}
			return new Response(JSON.stringify(listResponse("qwen/qwen3-32b").body), { status: 200 });
		}) as typeof globalThis.fetch;

		try {
			const cards = await getDiscoverer("novita")!.discover(validCredential);
			expect(cards).toHaveLength(1);
			expect(calls.at(-1)).toBe("https://api.novita.ai/openai/v1/models");
		} finally {
			globalThis.fetch = original;
		}
	});

	it("reports an auth failure as auth, not as a missing endpoint", async () => {
		// The endpoint chain used to walk past a 401 to a path that never existed
		// and report that path's 404, which hid every expired-key diagnosis.
		mockFetch({
			"https://api.x.ai/v1/models": { status: 401, body: { error: "invalid api key" } },
		});

		await expect(getDiscoverer("xai")!.discover(validCredential)).rejects.toThrow(/401/);
	});

	it("skips the network entirely for a seed-only provider", async () => {
		// Tinker serves Inkling over an Anthropic-wire endpoint with no model
		// list, so discovery must not depend on one existing.
		const spec = getGenericProviderSpec("thinkingmachines");
		expect(spec?.seedOnly).toBe(true);

		const original = globalThis.fetch;
		let listCalls = 0;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("tinker.thinkingmachines.dev")) listCalls++;
			return new Response("{}", { status: 404 });
		}) as typeof globalThis.fetch;

		try {
			await new GenericOpenAICompatibleDiscoverer(spec!).discover(validCredential);
			expect(listCalls).toBe(0);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("regional provider pairs", () => {
	it("points Moonshot at the international host by default and .cn on request", () => {
		// kosha shipped `api.moonshot.cn` as the only Moonshot host, which an
		// international key cannot authenticate against.
		expect(new MoonshotDiscoverer().baseUrl).toBe("https://api.moonshot.ai");
		expect(new MoonshotDiscoverer("cn").baseUrl).toBe("https://api.moonshot.cn");
		expect(new MoonshotDiscoverer("cn").providerId).toBe("moonshot-cn");
		expect(getProviderDescriptor("moonshot")?.defaultBaseUrl).toBe("https://api.moonshot.ai");
		expect(getProviderDescriptor("moonshot-cn")?.defaultBaseUrl).toBe("https://api.moonshot.cn");
	});

	it("separates MiniMax by region", () => {
		expect(new MiniMaxDiscoverer().baseUrl).toBe("https://api.minimax.io");
		expect(new MiniMaxDiscoverer("cn").baseUrl).toBe("https://api.minimaxi.com");
		expect(new MiniMaxDiscoverer("cn").providerId).toBe("minimax-cn");
	});

	it("gives each region its own provider so prices cannot collide", () => {
		// The same model ID is priced differently per region (Qwen 2.5 72B runs
		// $1.40/M international against $0.574/M in China), so one merged
		// provider would make a model's price depend on which host answered.
		for (const [intl, cn] of [
			["moonshot", "moonshot-cn"],
			["minimax", "minimax-cn"],
			["alibaba", "alibaba-cn"],
			["siliconflow", "siliconflow-cn"],
			["stepfun", "stepfun-cn"],
		]) {
			const a = getProviderDescriptor(intl);
			const b = getProviderDescriptor(cn);
			expect(a, `missing ${intl}`).toBeDefined();
			expect(b, `missing ${cn}`).toBeDefined();
			expect(a?.defaultBaseUrl).not.toBe(b?.defaultBaseUrl);
			expect(getDiscoverer(cn)?.providerId).toBe(cn);
		}
	});

	it("keeps each region's discoverer classifying models identically", async () => {
		for (const region of ["moonshot", "moonshot-cn"] as const) {
			const discoverer = getDiscoverer(region)!;
			mockFetch({ [`${discoverer.baseUrl}/v1/models`]: listResponse("kimi-k2.5-vision") });
			const cards = await discoverer.discover(validCredential);
			expect(cards[0].capabilities).toContain("vision");
			expect(cards[0].originProvider).toBe("moonshot");
			restoreFetch();
		}
	});
});
