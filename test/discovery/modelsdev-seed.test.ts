/**
 * Tests for the models.dev seed: lifecycle, release date and provenance
 * carried from the public catalog onto keyless ModelCards.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/discovery/modelsdev-catalog.js", () => ({
	loadModelsDevCatalog: vi.fn(async () => ({
		openai: {
			id: "openai",
			models: {
				"gpt-6-sol": {
					id: "gpt-6-sol",
					name: "GPT-6 Sol",
					release_date: "2026-09-22",
					tool_call: true,
					modalities: { input: ["text", "image"], output: ["text"] },
					cost: { input: 2, output: 10 },
					limit: { context: 1_050_000, output: 128_000 },
				},
				"o4-mini": { id: "o4-mini", status: "deprecated", release_date: "2025-04-16" },
				"gpt-beta": { id: "gpt-beta", status: "beta", release_date: "2026-08" },
				"gpt-odd": { id: "gpt-odd", status: "sunsetting-soon", release_date: "next tuesday" },
			},
		},
	})),
}));

import { getModelsDevSeed } from "../../src/discovery/modelsdev-seed.js";

describe("getModelsDevSeed — lifecycle and provenance", () => {
	it("carries release date and marks the catalog it came from", async () => {
		const sol = (await getModelsDevSeed("openai")).find((c) => c.id === "gpt-6-sol");
		expect(sol?.releaseDate).toBe("2026-09-22");
		expect(sol?.catalogSource).toBe("models.dev");
		// `source` stays on the contract value consumers already switch on.
		expect(sol?.source).toBe("litellm");
		// GA models are left unset so the LiteLLM pass can still date a sunset.
		expect(sol?.status).toBeUndefined();
	});

	it("maps deprecated and pre-GA markers onto ModelStatus", async () => {
		const cards = await getModelsDevSeed("openai");
		expect(cards.find((c) => c.id === "o4-mini")?.status).toBe("deprecated");
		expect(cards.find((c) => c.id === "gpt-beta")?.status).toBe("preview");
		expect(cards.find((c) => c.id === "gpt-beta")?.releaseDate).toBe("2026-08");
	});

	it("ignores markers and dates it does not recognise", async () => {
		const odd = (await getModelsDevSeed("openai")).find((c) => c.id === "gpt-odd");
		expect(odd).toBeDefined();
		expect(odd?.status).toBeUndefined();
		expect(odd?.releaseDate).toBeUndefined();
	});
});
