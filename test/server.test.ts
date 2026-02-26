/**
 * kosha-discovery — Comprehensive tests for the Hono HTTP API server.
 *
 * Tests every route exposed by {@link createServer} using Hono's built-in
 * `app.request()` helper so no real HTTP listener is required.
 *
 * Fixture data: two providers (Anthropic with 2 models, OpenAI with 1 model)
 * populated via {@link ModelRegistry.fromJSON} to keep tests deterministic
 * and free of network I/O.
 * @module
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

// ---------------------------------------------------------------------------
//  Test helpers — mirrors the pattern used in registry.test.ts
// ---------------------------------------------------------------------------

/** Create a minimal {@link ModelCard} with sensible defaults. */
function makeModel(overrides: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
	return {
		name: overrides.id,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing: undefined,
		...overrides,
	};
}

/** Create a minimal {@link ProviderInfo}. */
function makeProvider(id: string, name: string, models: ModelCard[]): ProviderInfo {
	return {
		id,
		name,
		baseUrl: `https://api.${id}.com`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
	};
}

// ---------------------------------------------------------------------------
//  Fixture data
// ---------------------------------------------------------------------------

const sonnet = makeModel({
	id: "claude-sonnet-4-20250514",
	provider: "anthropic",
	name: "Claude Sonnet 4",
	mode: "chat",
	capabilities: ["chat", "vision", "code"],
});

const opus = makeModel({
	id: "claude-opus-4-20250918",
	provider: "anthropic",
	name: "Claude Opus 4",
	mode: "chat",
	capabilities: ["chat", "vision", "code", "function_calling"],
});

const embedding = makeModel({
	id: "text-embedding-3-small",
	provider: "openai",
	name: "Text Embedding 3 Small",
	mode: "embedding",
	capabilities: ["embedding"],
	contextWindow: 8_191,
	maxOutputTokens: 0,
});

const anthropicProvider = makeProvider("anthropic", "Anthropic", [sonnet, opus]);
const openaiProvider = makeProvider("openai", "OpenAI", [embedding]);

/** Total models across all providers. */
const TOTAL_MODELS = 3;

// ---------------------------------------------------------------------------
//  Shared app instance
// ---------------------------------------------------------------------------

let app: Hono;

beforeAll(() => {
	const registry = ModelRegistry.fromJSON({
		providers: [anthropicProvider, openaiProvider],
		aliases: {
			sonnet: "claude-sonnet-4-20250514",
			opus: "claude-opus-4-20250918",
		},
		discoveredAt: Date.now(),
	});

	app = createServer(registry);
});

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("Hono API Server — createServer()", () => {
	// ── GET /api/models ──────────────────────────────────────────────

	describe("GET /api/models", () => {
		it("returns all models with a count", async () => {
			const res = await app.request("/api/models");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(TOTAL_MODELS);
			expect(body.models).toHaveLength(TOTAL_MODELS);
		});

		it("filters by provider (provider=anthropic)", async () => {
			const res = await app.request("/api/models?provider=anthropic");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(2);
			expect(body.models.every((m: ModelCard) => m.provider === "anthropic")).toBe(true);
		});

		it("filters by mode (mode=chat)", async () => {
			const res = await app.request("/api/models?mode=chat");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(2);
			expect(body.models.every((m: ModelCard) => m.mode === "chat")).toBe(true);
		});

		it("filters by mode (mode=embedding)", async () => {
			const res = await app.request("/api/models?mode=embedding");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(1);
			expect(body.models[0].id).toBe("text-embedding-3-small");
		});

		it("filters by capability (capability=vision)", async () => {
			const res = await app.request("/api/models?capability=vision");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(2);

			const ids = body.models.map((m: ModelCard) => m.id).sort();
			expect(ids).toEqual(["claude-opus-4-20250918", "claude-sonnet-4-20250514"]);
		});

		it("filters by capability (capability=function_calling)", async () => {
			const res = await app.request("/api/models?capability=function_calling");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(1);
			expect(body.models[0].id).toBe("claude-opus-4-20250918");
		});

		it("returns an empty array for an unmatched provider filter", async () => {
			const res = await app.request("/api/models?provider=nonexistent");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(0);
			expect(body.models).toEqual([]);
		});

		it("combines provider and mode filters", async () => {
			const res = await app.request("/api/models?provider=openai&mode=embedding");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(1);
			expect(body.models[0].id).toBe("text-embedding-3-small");
		});
	});

	// ── GET /api/models/:idOrAlias ───────────────────────────────────

	describe("GET /api/models/:idOrAlias", () => {
		it("returns a single model by canonical ID", async () => {
			const res = await app.request("/api/models/claude-sonnet-4-20250514");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.id).toBe("claude-sonnet-4-20250514");
			expect(body.name).toBe("Claude Sonnet 4");
			expect(body.provider).toBe("anthropic");
		});

		it("returns a single model by alias", async () => {
			const res = await app.request("/api/models/opus");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.id).toBe("claude-opus-4-20250918");
		});

		it("returns 404 for an unknown model", async () => {
			const res = await app.request("/api/models/does-not-exist");
			expect(res.status).toBe(404);

			const body = await res.json();
			expect(body.error).toBe("Model not found");
			expect(body.id).toBe("does-not-exist");
		});
	});

	// ── GET /api/providers ───────────────────────────────────────────

	describe("GET /api/providers", () => {
		it("returns provider summaries with count", async () => {
			const res = await app.request("/api/providers");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.count).toBe(2);
			expect(body.providers).toHaveLength(2);
		});

		it("returns summary fields only (no full model arrays)", async () => {
			const res = await app.request("/api/providers");
			const body = await res.json();

			for (const provider of body.providers) {
				// Summary fields that should be present
				expect(provider).toHaveProperty("id");
				expect(provider).toHaveProperty("name");
				expect(provider).toHaveProperty("baseUrl");
				expect(provider).toHaveProperty("authenticated");
				expect(provider).toHaveProperty("modelCount");
				expect(provider).toHaveProperty("lastRefreshed");

				// Full models array must NOT be present in the summary
				expect(provider).not.toHaveProperty("models");
			}
		});

		it("includes correct model counts per provider", async () => {
			const res = await app.request("/api/providers");
			const body = await res.json();

			const anthropicSummary = body.providers.find(
				(p: { id: string }) => p.id === "anthropic",
			);
			const openaiSummary = body.providers.find(
				(p: { id: string }) => p.id === "openai",
			);

			expect(anthropicSummary.modelCount).toBe(2);
			expect(openaiSummary.modelCount).toBe(1);
		});
	});

	// ── GET /api/providers/:id ───────────────────────────────────────

	describe("GET /api/providers/:id", () => {
		it("returns a full provider with its models", async () => {
			const res = await app.request("/api/providers/anthropic");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.id).toBe("anthropic");
			expect(body.name).toBe("Anthropic");
			expect(body.models).toHaveLength(2);
			expect(body.authenticated).toBe(true);
		});

		it("returns 404 for an unknown provider", async () => {
			const res = await app.request("/api/providers/unknown-provider");
			expect(res.status).toBe(404);

			const body = await res.json();
			expect(body.error).toBe("Provider not found");
			expect(body.id).toBe("unknown-provider");
		});
	});

	// ── GET /api/resolve/:alias ──────────────────────────────────────

	describe("GET /api/resolve/:alias", () => {
		it("resolves a known alias (isAlias=true)", async () => {
			const res = await app.request("/api/resolve/sonnet");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.alias).toBe("sonnet");
			expect(body.resolved).toBe("claude-sonnet-4-20250514");
			expect(body.isAlias).toBe(true);
		});

		it("returns the same value for an unknown alias (isAlias=false)", async () => {
			const res = await app.request("/api/resolve/not-an-alias");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.alias).toBe("not-an-alias");
			expect(body.resolved).toBe("not-an-alias");
			expect(body.isAlias).toBe(false);
		});

		it("resolves a second alias correctly", async () => {
			const res = await app.request("/api/resolve/opus");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.alias).toBe("opus");
			expect(body.resolved).toBe("claude-opus-4-20250918");
			expect(body.isAlias).toBe(true);
		});
	});

	// ── GET /health ──────────────────────────────────────────────────

	describe("GET /health", () => {
		it("returns status, model count, and provider count", async () => {
			const res = await app.request("/health");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.status).toBe("ok");
			expect(body.models).toBe(TOTAL_MODELS);
			expect(body.providers).toBe(2);
			expect(typeof body.uptime).toBe("number");
			expect(body.uptime).toBeGreaterThan(0);
		});
	});

	// ── 404 for unregistered routes ──────────────────────────────────

	describe("unregistered routes", () => {
		it("returns 404 for a completely unknown path", async () => {
			const res = await app.request("/does-not-exist");
			expect(res.status).toBe(404);
		});
	});
});
