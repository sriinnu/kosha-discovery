import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELSDEV_CATALOG_URL, resetModelsDevCatalogCache } from "../src/discovery/modelsdev-catalog.js";
import { evidenceFrom, type PriceEvidence, priceAgreement } from "../src/discovery/price-evidence.js";
import { getPublicSeed } from "../src/discovery/public-seed.js";
import { LITELLM_CATALOG_URL, resetLiteLLMCatalogCache } from "../src/enrichment/litellm-catalog.js";
import type { ModelCard } from "../src/types.js";

const said = (source: PriceEvidence["source"], input: number, output: number): PriceEvidence => ({
	source,
	inputPerMillion: input,
	outputPerMillion: output,
});

describe("priceAgreement", () => {
	it("calls no evidence, or one source, single", () => {
		expect(priceAgreement(undefined)).toBe("single");
		expect(priceAgreement([said("models.dev", 1, 2)])).toBe("single");
	});

	it("allows rounding but not a believable lie", () => {
		expect(priceAgreement([said("models.dev", 1, 2), said("litellm", 1.04, 2)])).toBe("agree");
		expect(priceAgreement([said("models.dev", 1, 2), said("litellm", 1.4, 2)])).toBe("disagree");
		expect(priceAgreement([said("models.dev", 1, 2), said("litellm", 1, 2.8)])).toBe("disagree");
	});

	it("needs all three witnesses to line up", () => {
		expect(priceAgreement([said("provider-api", 1, 2), said("models.dev", 1, 2), said("litellm", 3, 6)])).toBe(
			"disagree",
		);
	});

	it("doesn't take a catalog's $0 as testimony", () => {
		const card = { pricing: { inputPerMillion: 0, outputPerMillion: 0 } } as ModelCard;
		expect(evidenceFrom(card, "models.dev")).toBeNull();
	});
});

describe("getPublicSeed evidence", () => {
	beforeEach(() => {
		resetModelsDevCatalogCache();
		resetLiteLLMCatalogCache();
		vi.stubEnv("KOSHA_CATALOG_SOURCE", "");
		const modelsDev = {
			deepseek: {
				id: "deepseek",
				models: {
					both: { id: "both", cost: { input: 1, output: 2 } },
					disputed: { id: "disputed", cost: { input: 1, output: 2 } },
					alone: { id: "alone", cost: { input: 5, output: 6 } },
				},
			},
		};
		const litellm = {
			"deepseek/both": {
				litellm_provider: "deepseek",
				input_cost_per_token: 1e-6,
				output_cost_per_token: 2e-6,
				mode: "chat",
			},
			"deepseek/disputed": {
				litellm_provider: "deepseek",
				input_cost_per_token: 9e-6,
				output_cost_per_token: 2e-6,
				mode: "chat",
			},
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url === MODELSDEV_CATALOG_URL) return new Response(JSON.stringify(modelsDev));
				if (url === LITELLM_CATALOG_URL) return new Response(JSON.stringify(litellm));
				throw new Error(`no network in this test: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		resetModelsDevCatalogCache();
		resetLiteLLMCatalogCache();
	});

	it("records both catalogs' prices when both list a model", async () => {
		const seeds = await getPublicSeed("deepseek");
		const card = (id: string) => seeds.find((c) => c.id === id);
		expect(priceAgreement(card("both")?.priceEvidence)).toBe("agree");
		expect(priceAgreement(card("disputed")?.priceEvidence)).toBe("disagree");
		expect(card("alone")?.priceEvidence).toBeUndefined();
		expect(card("both")?.priceEvidence?.map((e) => e.source)).toEqual(["models.dev", "litellm"]);
	});
});
