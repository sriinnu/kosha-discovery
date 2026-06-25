/**
 * Tests for the watch/integrate surface: registry.onChange and /metrics.
 */

import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

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

function model(id: string, p: string): ModelCard {
	return {
		id,
		name: id,
		provider: p,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing: { inputPerMillion: 1, outputPerMillion: 2 },
	};
}

describe("registry.onChange", () => {
	it("calls the handler when a real delta mutation is recorded", () => {
		// Drive the event bus directly with a non-empty delta payload so we
		// know the handler is wired to it. The earlier version of this test
		// drove `recordDiscoveryMutation` against an empty snapshot which is
		// a no-op for the emitter — so the assertion never actually proved
		// the subscription worked.
		const registry = new ModelRegistry();
		const deltas: Array<{ changes: unknown[] }> = [];
		const off = registry.onChange((delta) => {
			deltas.push(delta as { changes: unknown[] });
		});

		const bus = (
			registry as unknown as { state: { discoveryEventBus: { emit(name: string, payload: unknown): void } } }
		).state.discoveryEventBus;
		const payload = { changes: [{ entity: "model", action: "upsert", key: "openai:gpt-4", value: null }] };
		bus.emit("delta", payload);
		bus.emit("delta", payload);

		expect(deltas).toHaveLength(2);
		expect(deltas[0].changes).toHaveLength(1);

		// After unsubscribe, further emits must NOT be observed.
		off();
		bus.emit("delta", payload);
		expect(deltas).toHaveLength(2);
	});

	it("forwards handler errors to the optional onError callback", () => {
		const registry = new ModelRegistry();
		const errors: unknown[] = [];
		const off = registry.onChange(
			() => {
				throw new Error("kaboom");
			},
			(err) => errors.push(err),
		);
		// Synthesize an event directly on the event bus.
		const state = (registry as unknown as { state: { discoveryEventBus: { emit(name: string, payload: unknown): void } } }).state;
		state.discoveryEventBus.emit("delta", { changes: [] });
		off();
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe("kaboom");
	});
});

describe("GET /metrics", () => {
	it("escapes backslashes, double-quotes, and newlines in provider label values", async () => {
		// Provider ids are loaded from JSON and could in principle contain
		// chars that break the Prometheus label-value grammar. The exposition
		// must remain parseable; the escape is reversible.
		const provid = `nasty\\"id\nwith-breaks`;
		const registry = ModelRegistry.fromJSON({
			providers: [provider(provid, [model("m", provid)])],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const res = await createServer(registry).request("/metrics");
		expect(res.status).toBe(200);
		const body = await res.text();
		// Backslash + quote + newline must all appear escaped, not raw.
		expect(body).toContain('provider="nasty\\\\\\"id\\nwith-breaks"');
		// And the body must still be a clean line-per-metric document — no
		// raw CR/LF inside any label value.
		const lines = body.split("\n").filter((l) => l.startsWith("kosha_provider_"));
		for (const line of lines) {
			const labelStart = line.indexOf("{");
			const labelEnd = line.indexOf("}");
			expect(labelStart).toBeGreaterThan(-1);
			expect(labelEnd).toBeGreaterThan(labelStart);
		}
	});

	it("exposes registry counts and per-provider gauges in Prometheus text format", async () => {
		const registry = ModelRegistry.fromJSON({
			providers: [provider("openai", [model("gpt-4o-mini", "openai")])],
			aliases: {},
			discoveredAt: Date.now(),
		});
		const res = await createServer(registry).request("/metrics");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type") ?? "").toContain("text/plain");
		const body = await res.text();
		expect(body).toContain("kosha_models_total 1");
		expect(body).toContain("kosha_providers_total 1");
		expect(body).toContain('kosha_provider_breaker_open{provider="openai"}');
		expect(body).toContain('kosha_provider_reliability{provider="openai"}');
	});
});
