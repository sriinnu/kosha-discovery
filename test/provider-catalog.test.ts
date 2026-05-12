import { describe, expect, it } from "vitest";
import { getProviderCacheBehavior, getProviderDescriptor, normalizeProviderId } from "../src/provider-catalog.js";

describe("provider-catalog", () => {
	it("normalizes llama.cpp aliases to the canonical provider ID", () => {
		expect(normalizeProviderId("llama-cpp")).toBe("llama.cpp");
		expect(normalizeProviderId("llamacpp")).toBe("llama.cpp");
		expect(getProviderDescriptor("llama.cpp")?.isLocal).toBe(true);
	});

	it("normalizes google aliases to the canonical provider ID", () => {
		expect(normalizeProviderId("gemini")).toBe("google");
		expect(getProviderDescriptor("google")?.transport).toBe("native-http");
	});

	it("normalizes new provider aliases", () => {
		expect(normalizeProviderId("kimi")).toBe("moonshot");
		expect(normalizeProviderId("zhipu")).toBe("glm");
		expect(normalizeProviderId("z.ai")).toBe("zai");
		expect(normalizeProviderId("ai-gateway")).toBe("vercel");
		expect(normalizeProviderId("vercel-ai-gateway")).toBe("vercel");
		expect(getProviderDescriptor("moonshot")?.credentialRequired).toBe(true);
	});

	it("describes Vercel AI Gateway as a public catalog with authenticated execution", () => {
		expect(getProviderDescriptor("vercel")).toMatchObject({
			transport: "openai-compatible-http",
			credentialRequired: false,
			executionCredentialRequired: true,
			credentialEnvVars: ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"],
			primaryCredentialEnvVar: "AI_GATEWAY_API_KEY",
		});
	});

	describe("cacheBehavior", () => {
		it("exposes Anthropic's explicit 5m/1h cache tiers", () => {
			expect(getProviderCacheBehavior("anthropic")).toMatchObject({
				mode: "explicit",
				ttlTiers: ["5m", "1h"],
				defaultTtlSeconds: 300,
				maxTtlSeconds: 3600,
				documented: true,
			});
		});

		it("describes OpenAI's automatic cache with an approximate window", () => {
			const behavior = getProviderCacheBehavior("openai");
			expect(behavior?.mode).toBe("automatic");
			expect(behavior?.approximateTtlSeconds).toBeGreaterThan(0);
			expect(behavior?.documented).toBe(true);
		});

		it("captures Gemini Context Caching with a 7-day max TTL", () => {
			expect(getProviderCacheBehavior("google")).toMatchObject({
				mode: "explicit",
				defaultTtlSeconds: 3600,
				maxTtlSeconds: 604_800,
			});
			expect(getProviderCacheBehavior("gemini")?.maxTtlSeconds).toBe(604_800);
		});

		it("marks gateways as passthrough so callers know TTL inherits from the routed model", () => {
			expect(getProviderCacheBehavior("openrouter")?.mode).toBe("passthrough");
			expect(getProviderCacheBehavior("vercel")?.mode).toBe("passthrough");
			expect(getProviderCacheBehavior("bedrock")?.mode).toBe("passthrough");
			expect(getProviderCacheBehavior("vertex")?.mode).toBe("passthrough");
		});

		it("marks providers without a documented prompt cache as mode: none", () => {
			expect(getProviderCacheBehavior("groq")?.mode).toBe("none");
			expect(getProviderCacheBehavior("mistral")?.mode).toBe("none");
			expect(getProviderCacheBehavior("cohere")?.mode).toBe("none");
			expect(getProviderCacheBehavior("cerebras")?.mode).toBe("none");
			expect(getProviderCacheBehavior("perplexity")?.mode).toBe("none");
		});

		it("returns undefined for providers whose cache policy has not been curated", () => {
			expect(getProviderCacheBehavior("together")).toBeUndefined();
			expect(getProviderCacheBehavior("fireworks")).toBeUndefined();
			expect(getProviderCacheBehavior("nvidia")).toBeUndefined();
		});

		it("returns undefined for unknown providers", () => {
			expect(getProviderCacheBehavior("does-not-exist")).toBeUndefined();
			expect(getProviderCacheBehavior(undefined)).toBeUndefined();
		});
	});
});
