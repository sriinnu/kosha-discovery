/**
 * `kosha doctor` projects deprecation findings and provider health out of
 * the registry. Tests drive the JSON path so they don't depend on TTY colour.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdDoctor } from "../src/cli-cmd-doctor.js";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

function makeModel(o: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
	return {
		name: o.id,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		...o,
	};
}

function provider(id: string, models: ModelCard[]): ProviderInfo {
	return {
		id,
		name: id,
		baseUrl: `https://api.${id}.example`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("kosha doctor (JSON output)", () => {
	it("reports a deprecated model with its successor and a clean health row", async () => {
		// 30 days from today as a YYYY-MM-DD ISO string.
		const isoDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
		const registry = ModelRegistry.fromJSON({
			providers: [
				provider("openai", [
					makeModel({
						id: "gpt-3.5-turbo",
						provider: "openai",
						status: "deprecated",
						deprecationDate: isoDate,
						replacedBy: "gpt-4o-mini",
					}),
					makeModel({ id: "gpt-4o-mini", provider: "openai" }),
				]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});

		// Skip the registry.discover() inside cmdDoctor by stubbing it.
		vi.spyOn(registry, "discover").mockResolvedValue([]);
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await cmdDoctor(registry, { json: true });

		const payload = JSON.parse(String(out.mock.calls[0]?.[0]));
		expect(payload.deprecations).toHaveLength(1);
		expect(payload.deprecations[0]).toMatchObject({
			modelId: "gpt-3.5-turbo",
			provider: "openai",
			status: "deprecated",
			replacedBy: "gpt-4o-mini",
		});
		expect(payload.deprecations[0].daysUntilSunset).toBeGreaterThan(0);
		expect(payload.health.find((h: { providerId: string }) => h.providerId === "openai")).toMatchObject({
			breakerState: "closed",
			available: true,
		});
	});

	it("emits an empty deprecations list when no model has lifecycle signals", async () => {
		const registry = ModelRegistry.fromJSON({
			providers: [provider("groq", [makeModel({ id: "fast", provider: "groq" })])],
			aliases: {},
			discoveredAt: Date.now(),
		});
		vi.spyOn(registry, "discover").mockResolvedValue([]);
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await cmdDoctor(registry, { json: true });

		const payload = JSON.parse(String(out.mock.calls[0]?.[0]));
		expect(payload.deprecations).toEqual([]);
		expect(payload.health[0].providerId).toBe("groq");
	});
});
