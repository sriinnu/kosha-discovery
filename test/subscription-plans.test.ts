/**
 * Subscription plans: key routing between pay-as-you-go and plan hosts, the
 * shared-key claim (a sibling's refusal is quiet; a key nobody takes is
 * reported once), plan-billed cards, and plan catalog prices.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/discovery/modelsdev-catalog.js", () => ({
	loadModelsDevCatalog: vi.fn(async () => ({
		"alibaba-token-plan": {
			id: "alibaba-token-plan",
			models: {
				"qwen3.8-max": {
					id: "qwen3.8-max",
					name: "Qwen3.8 Max",
					tool_call: true,
					cost: { input: 0, output: 0 },
					limit: { context: 1_000_000, output: 131_072 },
				},
			},
		},
		"stepfun-step-plan": {
			id: "stepfun-step-plan",
			models: { "step-5-preview": { id: "step-5-preview", cost: { input: 0.6, output: 2.4 } } },
		},
		"kuae-cloud-coding-plan": {
			id: "kuae-cloud-coding-plan",
			models: { "GLM-4.7": { id: "GLM-4.7", cost: { input: 0, output: 0 } } },
		},
	})),
}));

import { CredentialResolver } from "../src/credentials/resolver.js";
import { buildCatalogOnlyRows } from "../src/discovery/catalog-only.js";
import { PlanKeyUnverifiedError } from "../src/discovery/generic-openai.js";
import { getDiscoverer } from "../src/discovery/index.js";
import { getModelsDevSeed, isSubscriptionPlanSlug } from "../src/discovery/modelsdev-seed.js";
import { getProviderDescriptor, PROVIDER_CATALOG } from "../src/provider-catalog.js";
import { registryClassifyError, registryRecordObservation } from "../src/registry-discovery.js";
import { fallbackRegistryCredential, registryDiscover } from "../src/registry-runtime.js";
import type { DiscoveryDependencies } from "../src/registry-state.js";
import { createRegistryState } from "../src/registry-state.js";
import { SUBSCRIPTION_PLANS } from "../src/subscription-plans.js";
import type { CredentialResult, ModelCard, ProviderDiscoverer } from "../src/types.js";
import { mockFetch, restoreFetch } from "./discovery/mock-server.js";

const PLAN_KEY = "sk-sp-test-plan-key";
const PAYG_KEY = "sk-test-payg-key";
const KIMI_CODE_KEY = "sk-kimi-test-code-key";

/** Every env var any provider reads, cleared per test so the host env can't leak in. */
const ALL_VARS = [...new Set(PROVIDER_CATALOG.flatMap((d) => d.credentialEnvVars)), "KOSHA_PLAN_KEY_PROBE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const name of ALL_VARS) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
});
afterEach(() => {
	for (const name of ALL_VARS) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
	restoreFetch();
});

describe("the plan table", () => {
	it("generates a catalog entry, a discoverer and a seed mapping for every plan", () => {
		for (const plan of SUBSCRIPTION_PLANS) {
			const descriptor = getProviderDescriptor(plan.providerId);
			expect(descriptor?.subscriptionPlan, plan.providerId).toBe(true);
			expect(descriptor?.defaultBaseUrl).toBe(plan.baseUrl);
			expect(getDiscoverer(plan.providerId)?.providerId).toBe(plan.providerId);
			expect(isSubscriptionPlanSlug(plan.providerId), plan.providerId).toBe(true);
		}
	});

	it("never lets a plan that can't test a key borrow a shared var", () => {
		// An open list (200 without a key) or no list can't tell a good key
		// from a bad one, so a borrowed key would always look accepted.
		for (const plan of SUBSCRIPTION_PLANS.filter((p) => p.listing !== "validates")) {
			expect(getProviderDescriptor(plan.providerId)?.credentialEnvVars).toEqual(plan.dedicatedEnvVars);
		}
	});

	it("carries the Anthropic wire for MiniMax's plan", () => {
		const descriptor = getProviderDescriptor("minimax-coding-plan");
		expect(descriptor?.wire).toBe("anthropic");
		expect(descriptor?.anthropicMessagesPath).toBe("/anthropic/v1/messages");
	});
});

describe("key routing", () => {
	const resolver = () => new CredentialResolver();

	it("keeps an Alibaba plan key off pay-as-you-go and offers it to the plans", async () => {
		// The original failure: an `sk-sp-` key in QWEN_API_KEY went to
		// dashscope-intl, got a 401, and qwen4-max-preview never showed.
		process.env.QWEN_API_KEY = PLAN_KEY;

		expect(await resolver().resolve("alibaba")).toEqual({ source: "none" });
		expect(await resolver().resolve("alibaba-token-plan")).toEqual({
			apiKey: PLAN_KEY,
			source: "env",
			envVar: "QWEN_API_KEY",
			shared: true,
		});
		// The China plan tries it too; Beijing's refusal is then quiet.
		expect((await resolver().resolve("alibaba-token-plan-cn")).shared).toBe(true);
		// Coding Plan's list answers without a key, so it can't test a borrowed one.
		expect(await resolver().resolve("alibaba-coding-plan")).toEqual({ source: "none" });
	});

	it("keeps a pay-as-you-go key on pay-as-you-go", async () => {
		process.env.QWEN_API_KEY = PAYG_KEY;
		expect((await resolver().resolve("alibaba")).apiKey).toBe(PAYG_KEY);
		expect(await resolver().resolve("alibaba-token-plan")).toEqual({ source: "none" });
	});

	it("treats a dedicated var as certain, not tentative", async () => {
		process.env.ALIBABA_TOKEN_PLAN_API_KEY = PLAN_KEY;
		expect(await resolver().resolve("alibaba-token-plan")).toMatchObject({ apiKey: PLAN_KEY, shared: false });
	});

	it("keeps plans to their dedicated vars when probing is off", async () => {
		process.env.KOSHA_PLAN_KEY_PROBE = "off";
		process.env.QWEN_API_KEY = PLAN_KEY;
		expect(await resolver().resolve("alibaba-token-plan")).toEqual({ source: "none" });
		process.env.ALIBABA_TOKEN_PLAN_API_KEY = PLAN_KEY;
		expect((await resolver().resolve("alibaba-token-plan")).apiKey).toBe(PLAN_KEY);
	});

	it("sends a Kimi For Coding key to the coding plan, not to Moonshot", async () => {
		process.env.KIMI_API_KEY = KIMI_CODE_KEY;
		expect(await resolver().resolve("moonshot")).toEqual({ source: "none" });
		expect(await resolver().resolve("moonshot-cn")).toEqual({ source: "none" });
		expect((await resolver().resolve("kimi-code-plan-global")).apiKey).toBe(KIMI_CODE_KEY);
	});

	it("gives the fallback path the same answer as the resolver", () => {
		// The fallback used to read only the primary var, so a plan key in
		// QWEN_API_KEY reached the plan one way and not the other.
		process.env.QWEN_API_KEY = PLAN_KEY;
		expect(fallbackRegistryCredential("alibaba")).toEqual({ source: "none" });
		expect(fallbackRegistryCredential("alibaba-token-plan")).toMatchObject({ apiKey: PLAN_KEY, shared: true });
	});
});

describe("shared-key claim during discovery", () => {
	let workDir: string;
	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "kosha-plans-"));
	});
	afterEach(() => rmSync(workDir, { recursive: true, force: true }));

	const card = (id: string, provider: string): ModelCard => ({
		id,
		name: id,
		provider,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 0,
		maxOutputTokens: 0,
		aliases: [],
		discoveredAt: 1,
		source: "api",
	});

	/** A discoverer that accepts `goodKey` and answers 401 to any other key. */
	function fake(providerId: string, goodKey: string | null, keyless: ModelCard[] = []): ProviderDiscoverer {
		return {
			providerId,
			providerName: providerId,
			baseUrl: `https://${providerId}.example`,
			async discover(credential) {
				if (credential.source === "none") return keyless;
				if (credential.apiKey === goodKey) return [card(`${providerId}-model`, providerId)];
				throw new Error(`${providerId} API error: 401 Unauthorized`);
			},
		};
	}

	async function run(discoverers: ProviderDiscoverer[], credentials: Record<string, CredentialResult>) {
		const state = createRegistryState({ cacheDir: join(workDir, "cache") });
		const dependencies: DiscoveryDependencies = {
			resolveCredential: null,
			loadDiscoverers: async () => discoverers,
			enrichModels: async () => undefined,
			populateModelAliases: () => undefined,
			loadFromCache: async () => false,
			saveToCache: async () => undefined,
			fallbackCredential: (id) => credentials[id] ?? { source: "none" },
			snapshotForDelta: () => null,
			recordDiscoveryMutation: () => undefined,
			recordObservation: (providerId, entry) => registryRecordObservation(state, providerId, entry),
			classifyError: (message) => registryClassifyError(message),
		};
		const providers = await registryDiscover(state, dependencies, { force: true });
		return { state, providers, byId: new Map(providers.map((p) => [p.id, p])) };
	}

	const shared: CredentialResult = { apiKey: PLAN_KEY, source: "env", envVar: "QWEN_API_KEY", shared: true };

	it("lists the plan that accepts a shared key, and keeps the siblings' refusals quiet", async () => {
		const { state, byId } = await run(
			[
				fake("alibaba", null, [card("qwen3.8-plus", "alibaba")]),
				fake("alibaba-token-plan", PLAN_KEY),
				fake("alibaba-token-plan-cn", null),
			],
			{ alibaba: { source: "none" }, "alibaba-token-plan": shared, "alibaba-token-plan-cn": shared },
		);

		expect(byId.get("alibaba-token-plan")?.authenticated).toBe(true);
		expect(byId.has("alibaba-token-plan-cn")).toBe(false);
		expect(byId.get("alibaba")?.degradedReason).toBeUndefined();
		expect(state.lastDiscoveryErrors).toEqual([]);
		// A sibling's 401 is not this provider failing.
		expect(state.healthTracker.breaker("alibaba-token-plan-cn").canExecute()).toBe(true);
	});

	it("reports a shared key every reader refuses, once, naming each host", async () => {
		const { state, byId } = await run(
			[
				fake("alibaba", "nope", [card("qwen3.8-plus", "alibaba")]),
				fake("alibaba-token-plan", "nope"),
				fake("alibaba-token-plan-cn", "nope"),
			],
			{
				alibaba: { ...shared, apiKey: "sk-dead" },
				"alibaba-token-plan": { ...shared, apiKey: "sk-dead" },
				"alibaba-token-plan-cn": { ...shared, apiKey: "sk-dead" },
			},
		);

		expect(state.lastDiscoveryErrors).toHaveLength(1);
		const reason = state.lastDiscoveryErrors[0].error;
		expect(reason).toContain("QWEN_API_KEY");
		for (const id of ["alibaba", "alibaba-token-plan", "alibaba-token-plan-cn"]) expect(reason).toContain(id);
		// Pay-as-you-go stays listed from the catalog, carrying the warning.
		expect(byId.get("alibaba")?.models.map((m) => m.id)).toEqual(["qwen3.8-plus"]);
		expect(byId.get("alibaba")?.degradedReason).toBe(reason);
		expect(byId.has("alibaba-token-plan")).toBe(false);
	});

	it("still warns loudly about a dedicated key that is refused", async () => {
		const dedicated: CredentialResult = {
			apiKey: "sk-sp-dead",
			source: "env",
			envVar: "ALIBABA_TOKEN_PLAN_API_KEY",
			shared: false,
		};
		const { state } = await run([fake("alibaba-token-plan", null, [card("qwen3.8-max", "alibaba-token-plan")])], {
			"alibaba-token-plan": dedicated,
		});
		expect(state.lastDiscoveryErrors).toEqual([
			expect.objectContaining({
				providerId: "alibaba-token-plan",
				error: "alibaba-token-plan API error: 401 Unauthorized",
			}),
		]);
	});

	it("leaves a plan out entirely when no key resolves for it", async () => {
		const { byId } = await run([fake("alibaba-token-plan", null, [card("qwen3.8-max", "alibaba-token-plan")])], {});
		expect(byId.has("alibaba-token-plan")).toBe(false);
	});

	it("doesn't count a plan that couldn't test the key as a refusal", async () => {
		const unverified: ProviderDiscoverer = {
			...fake("minimax-coding-plan", null),
			async discover() {
				throw new PlanKeyUnverifiedError("MiniMax Token Plan");
			},
		};
		const key: CredentialResult = { apiKey: "sk-cp-x", source: "env", envVar: "MINIMAX_API_KEY", shared: true };
		const { state, byId } = await run([fake("minimax", "sk-cp-x"), unverified], {
			minimax: key,
			"minimax-coding-plan": key,
		});
		expect(byId.has("minimax-coding-plan")).toBe(false);
		expect(state.lastDiscoveryErrors).toEqual([]);
	});
});

describe("plan discovery", () => {
	const tokenPlanList = (...ids: string[]) => ({
		"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models": {
			status: 200,
			body: { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "system" })) },
		},
	});

	it("lists live plan models as plan-billed, with limits from the plan catalog", async () => {
		mockFetch(tokenPlanList("qwen3.8-max", "qwen4-max-preview", "glm-5.3", "wan2.7-image", "wan3.0-video"));
		const cards = await getDiscoverer("alibaba-token-plan")!.discover({ apiKey: PLAN_KEY, source: "env" });
		const byId = new Map(cards.map((c) => [c.id, c]));

		expect(byId.get("qwen4-max-preview")).toMatchObject({ provider: "alibaba-token-plan", originProvider: "qwen" });
		expect(byId.get("qwen4-max-preview")?.rawCapabilities).toContain("subscription_plan");
		expect(byId.get("qwen4-max-preview")?.pricing).toBeUndefined();
		expect(byId.get("qwen3.8-max")).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 131_072 });
		expect(byId.get("glm-5.3")?.originProvider).toBe("zai");
		expect(byId.get("wan2.7-image")?.mode).toBe("image");
		expect(byId.get("wan3.0-video")).toMatchObject({ mode: "video", originProvider: "alibaba" });
	});

	it("refuses to claim a shared key on a plan whose list route doesn't exist", async () => {
		mockFetch({
			"https://api.minimax.io/anthropic/v1/models": { status: 404, body: {} },
			"https://api.minimax.io/anthropic/v1/v1/models": { status: 404, body: {} },
		});
		const discoverer = getDiscoverer("minimax-coding-plan")!;
		await expect(
			discoverer.discover({ apiKey: "sk-cp-x", source: "env", envVar: "MINIMAX_API_KEY", shared: true }),
		).rejects.toThrow(PlanKeyUnverifiedError);
	});

	it("lists the catalog for a plan with no list route when its own key is set", async () => {
		const cards = await getDiscoverer("kuae-cloud-coding-plan")!.discover({ apiKey: "k", source: "env" });
		expect(cards.map((c) => c.id)).toEqual(["GLM-4.7"]);
		expect(cards[0].rawCapabilities).toContain("subscription_plan");
	});
});

describe("plan catalog prices", () => {
	it("drops a plan's $0 and its nonzero figures alike", async () => {
		// $0 is the subscription; a nonzero figure may be overage or a copied
		// pay-as-you-go rate, and nothing says which.
		const [max] = await getModelsDevSeed("alibaba-token-plan");
		expect(max.pricing).toBeUndefined();
		expect(max.capabilities).not.toContain("free_tier");
		const [step] = await getModelsDevSeed("stepfun-step-plan");
		expect(step.pricing).toBeUndefined();
		expect(step.rawCapabilities).toContain("subscription_plan");
	});

	it("keeps an unused plan's models as price-only rows", async () => {
		const unused = await buildCatalogOnlyRows([]);
		expect(unused.some((row) => (row as unknown as { providerId: string }).providerId === "alibaba-token-plan")).toBe(
			true,
		);
		const listed = await buildCatalogOnlyRows(["alibaba-token-plan"]);
		expect(listed.some((row) => (row as unknown as { providerId: string }).providerId === "alibaba-token-plan")).toBe(
			false,
		);
	});
});
