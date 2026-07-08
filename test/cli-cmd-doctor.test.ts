/**
 * `kosha doctor` projects deprecation findings and provider health out of
 * the registry. Tests drive the JSON path so they don't depend on TTY colour.
 *
 * The CI gate (`--ci` / `--fail-on-warning`) is driven through the same flag
 * map the dispatcher produces; `process.exit` is mocked to throw so the gate
 * can be asserted without tearing down the test process.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCTOR_CI_EXIT_CODE, cmdDoctor } from "../src/cli-cmd-doctor.js";
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

/**
 * `process.exit` is typed `=> never`; mock it to throw so the gate halts
 * execution and the requested code can be asserted. Each call returns the
 * spy so the test can check `toHaveBeenCalledWith` / `not.toHaveBeenCalled`.
 */
function stubExit(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit:${code ?? 0}`);
	}) as never);
}

describe("kosha doctor --ci (CI gate)", () => {
	it("exits with code 2 when --ci is set and a deprecated model exists", async () => {
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
				]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		vi.spyOn(registry, "discover").mockResolvedValue([]);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exit = stubExit();

		await expect(cmdDoctor(registry, { ci: true })).rejects.toThrow(`process.exit:${DOCTOR_CI_EXIT_CODE}`);
		expect(exit).toHaveBeenCalledWith(DOCTOR_CI_EXIT_CODE);
	});

	it("exits 0 (no non-zero exit) under --ci when every model is active", async () => {
		const registry = ModelRegistry.fromJSON({
			providers: [
				provider("groq", [
					makeModel({ id: "fast", provider: "groq", status: "active" }),
					makeModel({ id: "fast2", provider: "groq", status: "preview" }),
				]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		vi.spyOn(registry, "discover").mockResolvedValue([]);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const exit = stubExit();

		await cmdDoctor(registry, { ci: true });

		expect(exit).not.toHaveBeenCalled();
	});

	it("stays advisory (exit 0) without --ci even when a model is deprecated", async () => {
		const isoDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
		const registry = ModelRegistry.fromJSON({
			providers: [
				provider("openai", [
					makeModel({
						id: "gpt-3.5-turbo",
						provider: "openai",
						status: "deprecated",
						deprecationDate: isoDate,
					}),
				]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		vi.spyOn(registry, "discover").mockResolvedValue([]);
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const exit = stubExit();

		await cmdDoctor(registry, { json: true });

		expect(exit).not.toHaveBeenCalled();
		// Advisory payload still surfaces the finding; the gate just doesn't fire.
		const payload = JSON.parse(String(out.mock.calls[0]?.[0]));
		expect(payload.deprecations).toHaveLength(1);
	});

	it("treats --fail-on-warning as an alias for --ci", async () => {
		const isoDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
		const registry = ModelRegistry.fromJSON({
			providers: [
				provider("openai", [
					makeModel({
						id: "gpt-3.5-turbo",
						provider: "openai",
						status: "deprecated",
						deprecationDate: isoDate,
					}),
				]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		vi.spyOn(registry, "discover").mockResolvedValue([]);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exit = stubExit();

		await expect(cmdDoctor(registry, { "fail-on-warning": true })).rejects.toThrow(
			`process.exit:${DOCTOR_CI_EXIT_CODE}`,
		);
		expect(exit).toHaveBeenCalledWith(DOCTOR_CI_EXIT_CODE);
	});

	it("respects --deprecation-window: a far-future sunset trips only when the window widens", async () => {
		// ~100 days out — beyond the default 30d window, inside a widened one.
		const farDate = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
		const buildRegistry = () =>
			ModelRegistry.fromJSON({
				providers: [
					provider("openai", [
						makeModel({
							id: "future-sunset",
							provider: "openai",
							status: "active",
							deprecationDate: farDate,
						}),
					]),
				],
				aliases: {},
				discoveredAt: Date.now(),
			});

		// Default window (30): a 100d sunset on an active model stays advisory.
		{
			const registry = buildRegistry();
			vi.spyOn(registry, "discover").mockResolvedValue([]);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const exit = stubExit();
			await cmdDoctor(registry, { ci: true });
			expect(exit).not.toHaveBeenCalled();
		}

		// Widened window (200): the same sunset now trips the gate.
		{
			const registry = buildRegistry();
			vi.spyOn(registry, "discover").mockResolvedValue([]);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const exit = stubExit();
			await expect(cmdDoctor(registry, { ci: true, "deprecation-window": "200" })).rejects.toThrow(
				`process.exit:${DOCTOR_CI_EXIT_CODE}`,
			);
			expect(exit).toHaveBeenCalledWith(DOCTOR_CI_EXIT_CODE);
		}
	});

	it("trips the gate for a near-future sunset within the default window even when status is active", async () => {
		// 10 days out — inside the default 30d window.
		const nearDate = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
		const registry = ModelRegistry.fromJSON({
			providers: [
				provider("openai", [
					makeModel({
						id: "near-sunset",
						provider: "openai",
						status: "active",
						deprecationDate: nearDate,
					}),
				]),
			],
			aliases: {},
			discoveredAt: Date.now(),
		});
		vi.spyOn(registry, "discover").mockResolvedValue([]);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exit = stubExit();

		await expect(cmdDoctor(registry, { ci: true })).rejects.toThrow(
			`process.exit:${DOCTOR_CI_EXIT_CODE}`,
		);
		expect(exit).toHaveBeenCalledWith(DOCTOR_CI_EXIT_CODE);
	});
});
