import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

/** Create a compact test model with stable defaults. */
function makeModel(overrides: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
	return {
		name: overrides.id,
		mode: "chat",
		capabilities: ["chat"],
		rawCapabilities: overrides.capabilities ?? ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: 1_710_000_000_000,
		source: "manual",
		...overrides,
	};
}

/** Create a compact provider fixture. */
function makeProvider(id: string, name: string, models: ModelCard[], overrides?: Partial<ProviderInfo>): ProviderInfo {
	return {
		id,
		name,
		baseUrl: `https://api.${id}.com`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: 1_710_000_001_000,
		...overrides,
	};
}

function makeRegistry(): ModelRegistry {
	const localChat = makeModel({
		id: "gpt-4o-mini",
		provider: "llama.cpp",
		contextWindow: 131_072,
		maxOutputTokens: 4_096,
		localRuntime: {
			runtimeFamily: "llama.cpp",
			transport: "openai-compatible-http",
			tokenizerFamily: "llama",
			quantization: "Q4_K_M",
			memoryFootprintBytes: 4_600_000_000,
			computeTarget: "gpu",
			supportsStructuredOutput: true,
			supportsStreaming: true,
		},
		pricing: { inputPerMillion: 0.1, outputPerMillion: 0.2 },
	});

	const cloudChat = makeModel({
		id: "gpt-4o-mini",
		provider: "openai",
		pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
	});

	const embedding = makeModel({
		id: "text-embedding-3-small",
		provider: "openai",
		mode: "embedding",
		capabilities: ["embedding"],
		rawCapabilities: ["embedding"],
		contextWindow: 8_191,
		maxOutputTokens: 0,
		pricing: { inputPerMillion: 0.02, outputPerMillion: 0 },
	});

	const providers = [
		makeProvider("openai", "OpenAI", [cloudChat, embedding]),
		makeProvider("llama.cpp", "llama.cpp (Local)", [localChat], {
			baseUrl: "http://127.0.0.1:8080",
		}),
	];

	return ModelRegistry.fromJSON({
		providers,
		aliases: { mini: "gpt-4o-mini" },
		discoveredAt: 1_710_000_002_000,
	});
}

describe("ModelRegistry v1 discovery surfaces", () => {
	it("emits a stable v1 discovery snapshot", () => {
		const registry = makeRegistry();
		const snapshot = registry.discoverySnapshot();

		expect(snapshot.schemaVersion).toBe(1);
		expect(snapshot.cursor).toContain("discovery-");
		expect(snapshot.providers.find((provider) => provider.providerId === "llama.cpp")?.isLocal).toBe(true);

		const localModel = snapshot.models.find((model) => model.providerId === "llama.cpp");
		expect(localModel?.capabilities).toContain("local_exec");
		expect(localModel?.capabilities).toContain("structured_output");
		expect(localModel?.runtimeFamily).toBe("llama.cpp");
		expect(localModel?.supportsStreaming).toBe(true);
	});

	it("returns cheapest candidates using normalized discovery semantics", () => {
		const registry = makeRegistry();
		const result = registry.cheapestCandidates({ role: "embeddings" });

		expect(result.schemaVersion).toBe(1);
		expect(result.candidates).toBe(1);
		expect(result.matches[0].modelId).toBe("text-embedding-3-small");
		expect(result.matches[0].score).toBe(0.02);
	});

	it("returns binding hints and can prefer local providers", () => {
		const registry = makeRegistry();
		const binding = registry.executionBindingHints({
			role: "chat",
			preferLocalProviders: true,
			allowCrossProvider: false,
		});

		expect(binding.selectedProviderId).toBe("llama.cpp");
		expect(binding.preferredProviderIds).toEqual(["llama.cpp"]);
		expect(binding.candidateModelIds).toContain("gpt-4o-mini");
	});

	it("returns full upsert deltas without a cursor", () => {
		const registry = makeRegistry();
		const delta = registry.discoveryDelta();

		expect(delta.schemaVersion).toBe(1);
		expect(delta.resetRequired).toBe(false);
		expect(delta.changes.some((change) => change.entity === "provider" && change.action === "upsert")).toBe(true);
		expect(delta.changes.some((change) => change.entity === "model" && change.action === "upsert")).toBe(true);
	});

	it("aggregates model deltas after a mutation", () => {
		const registry = makeRegistry();
		const before = registry.discoverySnapshot();
		const providerMap = (registry as any).providerMap as Map<string, ProviderInfo>;
		const openai = providerMap.get("openai")!;

		openai.models.push(makeModel({
			id: "text-embedding-3-large",
			provider: "openai",
			mode: "embedding",
			capabilities: ["embedding"],
			rawCapabilities: ["embedding"],
			contextWindow: 8_191,
			maxOutputTokens: 0,
		}));
		(registry as any).discoveredAt = 1_710_000_003_000;
		(registry as any).recordDiscoveryMutation(before);

		const delta = registry.discoveryDelta({ sinceCursor: before.cursor });
		expect(delta.resetRequired).toBe(false);
		expect(delta.changes.some((change) => change.entity === "model" && change.action === "upsert")).toBe(true);
	});

	it("streams backlog deltas through watchDiscovery", async () => {
		const registry = makeRegistry();
		const before = registry.discoverySnapshot();
		const providerMap = (registry as any).providerMap as Map<string, ProviderInfo>;
		const openai = providerMap.get("openai")!;

		openai.models.push(makeModel({
			id: "rerank-english-v3.0",
			provider: "openai",
			mode: "rerank",
			capabilities: ["rerank"],
			rawCapabilities: ["rerank"],
		}));
		(registry as any).discoveredAt = 1_710_000_004_000;
		(registry as any).recordDiscoveryMutation(before);

		const iterator = registry.watchDiscovery({ sinceCursor: before.cursor });
		const first = await iterator.next();
		await iterator.return?.();

		expect(first.done).toBe(false);
		expect(first.value?.changes.some((change) => change.entity === "model")).toBe(true);
	});

	it("normalizes provider health into the v1 schema", () => {
		const registry = makeRegistry();
		(registry as any).recordObservation("openai", { latencyMs: 5_500, errorType: "timeout" });
		(registry as any).healthTracker.breaker("openai").onFailure("timed out after 5500ms");

		const health = registry.discoverySnapshot().health.find((entry) => entry.providerId === "openai");
		expect(health?.state).toBe("degraded");
		expect(health?.latencyClass).toBe("timeout");
		expect(health?.circuitState).toBe("closed");
	});
});
