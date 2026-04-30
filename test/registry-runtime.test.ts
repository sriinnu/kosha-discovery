/**
 * Tests the central-registry guarantees that downstream tools (tokmeter,
 * chitragupta, ayuh, …) rely on:
 *
 *  - Drop-preservation: a model that vanishes from the fresh fetch keeps its
 *    last-known data on disk. (Provider 503 must not wipe pricing.)
 *  - Provider-drop-preservation: same rule applied at the provider level.
 *  - Degraded-fresh defence: a fresh entry that came back with NO usable
 *    pricing while the old entry HAD pricing keeps the old pricing block.
 *  - Both-sides pricing: degraded-fresh predicate considers `originPricing`
 *    AND `pricing` independently — non-zero on either side counts as usable.
 *  - Schema-version guard: a manifest with a different schemaVersion is not
 *    Frankenstein-merged; the fresh snapshot rewrites the file.
 *  - Lock contention: a concurrent run that times out waiting must NOT
 *    unlink the lock file held by the active writer.
 *  - Cleanup happy path: a successful export removes its own lock.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DISCOVERY_SCHEMA_VERSION,
	type DiscoveryModelV1,
	type DiscoveryProviderV1,
	type DiscoverySnapshotV1,
} from "../src/discovery-contract.js";
import { exportRegistryManifest } from "../src/registry-runtime.js";
import { createRegistryState } from "../src/registry-state.js";

let workDir: string;
let manifestPath: string;
let lockPath: string;

beforeEach(() => {
	// cacheDir = workDir/cache; manifest derives to workDir/registry.json.
	// Each test gets its own tmpdir so parallel workers don't collide.
	workDir = mkdtempSync(join(tmpdir(), "kosha-rt-test-"));
	manifestPath = join(workDir, "registry.json");
	lockPath = `${manifestPath}.lock`;
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function makeState(snapshot: DiscoverySnapshotV1) {
	const state = createRegistryState({ cacheDir: join(workDir, "cache") });
	state.lastSnapshotCache = snapshot;
	return state;
}

function makeModel(
	overrides: Partial<DiscoveryModelV1> & { key: string; modelId: string; providerId: string },
): DiscoveryModelV1 {
	return {
		key: overrides.key,
		modelId: overrides.modelId,
		name: overrides.modelId,
		providerId: overrides.providerId,
		canonicalProviderId: overrides.providerId,
		originProviderId: overrides.providerId,
		mode: "chat",
		capabilities: ["chat"],
		rawCapabilities: ["chat"],
		contextWindow: 200_000,
		maxOutputTokens: 8_000,
		pricing: null,
		originPricing: null,
		dimensions: null,
		maxInputTokens: null,
		discoveredAt: Date.now(),
		source: "api",
		aliases: [],
		region: null,
		projectId: null,
		runtimeFamily: null,
		tokenizerFamily: null,
		quantization: null,
		memoryFootprintBytes: null,
		computeTarget: null,
		supportsStructuredOutput: null,
		supportsStreaming: null,
		toolDialect: null,
		structuredOutputModes: [],
		supportsParallelToolCalls: null,
		status: "active",
		deprecationDate: null,
		replacedBy: null,
		...overrides,
	};
}

function makeProvider(providerId: string, overrides: Partial<DiscoveryProviderV1> = {}): DiscoveryProviderV1 {
	return {
		providerId,
		canonicalProviderId: providerId,
		aliases: [],
		name: providerId,
		origin: providerId,
		isLocal: false,
		transport: "https",
		authenticated: true,
		credentialSource: "env",
		credentialsPresent: true,
		credentialsRequired: true,
		credentialEnvVars: [],
		modelCount: 0,
		lastRefreshed: Date.now(),
		baseUrl: "",
		...overrides,
	};
}

function makeSnapshot(models: DiscoveryModelV1[], providers: DiscoveryProviderV1[] = []): DiscoverySnapshotV1 {
	const providerSet =
		providers.length > 0 ? providers : [...new Set(models.map((m) => m.providerId))].map((p) => makeProvider(p));
	return {
		schemaVersion: DISCOVERY_SCHEMA_VERSION,
		discoveredAt: Date.now(),
		cursor: "test-cursor",
		providers: providerSet,
		models,
		roles: [],
		health: [],
		credentialPrompts: [],
	};
}

function readManifest(): DiscoverySnapshotV1 {
	return JSON.parse(readFileSync(manifestPath, "utf-8")) as DiscoverySnapshotV1;
}

describe("exportRegistryManifest — central-registry merge guarantees", () => {
	it("preserves models that the fresh fetch dropped", async () => {
		const opus = makeModel({ key: "anthropic:opus", modelId: "opus", providerId: "anthropic" });
		const sonnet = makeModel({ key: "anthropic:sonnet", modelId: "sonnet", providerId: "anthropic" });

		await exportRegistryManifest(makeState(makeSnapshot([opus, sonnet])));
		expect(
			readManifest()
				.models.map((m) => m.key)
				.sort(),
		).toEqual(["anthropic:opus", "anthropic:sonnet"]);

		// Second export — sonnet vanishes (provider 503, rate limit, …).
		// Old manifest's sonnet must survive on disk.
		await exportRegistryManifest(makeState(makeSnapshot([opus])));
		const merged = readManifest();
		expect(merged.models.map((m) => m.key).sort()).toEqual(["anthropic:opus", "anthropic:sonnet"]);
	});

	it("preserves providers that the fresh fetch dropped", async () => {
		const claude = makeModel({ key: "anthropic:opus", modelId: "opus", providerId: "anthropic" });
		const gpt = makeModel({ key: "openai:gpt-5", modelId: "gpt-5", providerId: "openai" });

		await exportRegistryManifest(makeState(makeSnapshot([claude, gpt])));
		expect(
			readManifest()
				.providers.map((p) => p.providerId)
				.sort(),
		).toEqual(["anthropic", "openai"]);

		// OpenAI completely missing from fresh — keep the provider entry.
		await exportRegistryManifest(makeState(makeSnapshot([claude])));
		expect(
			readManifest()
				.providers.map((p) => p.providerId)
				.sort(),
		).toEqual(["anthropic", "openai"]);
	});

	it("restores old pricing when fresh entry came back pricing-degraded", async () => {
		const priced = makeModel({
			key: "anthropic:opus",
			modelId: "opus",
			providerId: "anthropic",
			pricing: { inputPerMillion: 5, outputPerMillion: 25 },
			originPricing: { inputPerMillion: 5, outputPerMillion: 25 },
		});
		const degraded = makeModel({
			key: "anthropic:opus",
			modelId: "opus",
			providerId: "anthropic",
			pricing: null,
			originPricing: null,
		});

		await exportRegistryManifest(makeState(makeSnapshot([priced])));
		await exportRegistryManifest(makeState(makeSnapshot([degraded])));

		const merged = readManifest();
		const opus = merged.models.find((m) => m.key === "anthropic:opus");
		expect(opus?.pricing).toEqual({ inputPerMillion: 5, outputPerMillion: 25 });
		expect(opus?.originPricing).toEqual({ inputPerMillion: 5, outputPerMillion: 25 });
	});

	it("treats a model as priced when only the proxy side has rates (both-sides predicate)", async () => {
		// originPricing zero (placeholder), pricing non-zero — must count as usable
		// so degraded-fresh defence does NOT restore old data over a perfectly fine
		// fresh entry.
		const oldPriced = makeModel({
			key: "openrouter:claude",
			modelId: "claude",
			providerId: "openrouter",
			pricing: { inputPerMillion: 5, outputPerMillion: 25 },
			originPricing: { inputPerMillion: 5, outputPerMillion: 25 },
		});
		const freshProxyOnly = makeModel({
			key: "openrouter:claude",
			modelId: "claude",
			providerId: "openrouter",
			pricing: { inputPerMillion: 4, outputPerMillion: 20 },
			originPricing: { inputPerMillion: 0, outputPerMillion: 0 },
		});

		await exportRegistryManifest(makeState(makeSnapshot([oldPriced])));
		await exportRegistryManifest(makeState(makeSnapshot([freshProxyOnly])));

		const merged = readManifest();
		const claude = merged.models.find((m) => m.key === "openrouter:claude");
		// Fresh proxy pricing wins — old data NOT restored, because pricing side
		// alone is usable.
		expect(claude?.pricing).toEqual({ inputPerMillion: 4, outputPerMillion: 20 });
	});

	it("rewrites with fresh snapshot when on-disk schemaVersion is mismatched", async () => {
		// Plant a v999 manifest by hand. The schema-version guard must refuse
		// to merge V1 into V999 and just write the fresh snapshot.
		const planted = {
			schemaVersion: 999,
			discoveredAt: 0,
			cursor: "old",
			providers: [makeProvider("zombie")],
			models: [makeModel({ key: "zombie:dead", modelId: "dead", providerId: "zombie" })],
			roles: [],
			health: [],
			credentialPrompts: [],
		};
		writeFileSync(manifestPath, JSON.stringify(planted), "utf-8");

		const fresh = makeModel({ key: "anthropic:opus", modelId: "opus", providerId: "anthropic" });
		await exportRegistryManifest(makeState(makeSnapshot([fresh])));

		const merged = readManifest();
		expect(merged.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
		expect(merged.models.map((m) => m.key)).toEqual(["anthropic:opus"]);
		expect(merged.providers.map((p) => p.providerId)).toEqual(["anthropic"]);
	});

	it("removes its own lock file after a successful export", async () => {
		await exportRegistryManifest(
			makeState(makeSnapshot([makeModel({ key: "anthropic:opus", modelId: "opus", providerId: "anthropic" })])),
		);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does NOT unlink an active holder's lock when contention times out", async () => {
		// Simulate another live process holding the lock with a fresh PID.
		// The acquire loop will reach its 3s timeout, then the export's
		// finally must NOT unlink the file — that lock belongs to someone else.
		const fd = await open(lockPath, "wx");
		await fd.write(`${process.pid + 1}\n`); // arbitrary live-looking PID
		await fd.close();

		const before = readFileSync(lockPath, "utf-8");

		// Pre-write the manifest so the export doesn't try to do real work
		// before the lock acquire (sweepStaleTmpFiles + mkdir are fine).
		await exportRegistryManifest(
			makeState(makeSnapshot([makeModel({ key: "anthropic:opus", modelId: "opus", providerId: "anthropic" })])),
		);

		// Lock file must still exist with the same contents — we did not yank it.
		expect(existsSync(lockPath)).toBe(true);
		expect(readFileSync(lockPath, "utf-8")).toBe(before);
	}, 10_000);
});
