/**
 * kosha-discovery — Tests for invalid-param 400s on the additive discovery plane.
 *
 * Locks down the contract that a query parameter which is PRESENT but not
 * parseable (a typo'd boolean, a non-numeric `limit`, an unknown enum value)
 * yields HTTP 400 instead of silently defaulting and returning wrong results.
 * ABSENT params must keep the historical 200 / no-filter behavior.
 *
 * The Hono app is built with {@link createServer} exactly like
 * `server.test.ts` so these tests exercise the real wiring; this file owns
 * only the discovery-route 400 behavior and does not edit server.test.ts.
 * @module
 */

import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

// ---------------------------------------------------------------------------
//  Test helpers — mirrors the pattern used in server.test.ts
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
function makeProvider(id: string, name: string, models: ModelCard[], overrides?: Partial<ProviderInfo>): ProviderInfo {
	return {
		id,
		name,
		baseUrl: `https://api.${id}.com`,
		authenticated: true,
		credentialSource: "env",
		models,
		lastRefreshed: Date.now(),
		...overrides,
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
	pricing: { inputPerMillion: 3, outputPerMillion: 15 },
});

const opus = makeModel({
	id: "claude-opus-4-20250918",
	provider: "anthropic",
	name: "Claude Opus 4",
	mode: "chat",
	capabilities: ["chat", "vision", "code", "function_calling"],
	pricing: { inputPerMillion: 15, outputPerMillion: 75 },
});

const embedding = makeModel({
	id: "text-embedding-3-small",
	provider: "openai",
	name: "Text Embedding 3 Small",
	mode: "embedding",
	capabilities: ["embedding"],
	contextWindow: 8_191,
	maxOutputTokens: 0,
	pricing: { inputPerMillion: 0.02, outputPerMillion: 0 },
});

const anthropicProvider = makeProvider("anthropic", "Anthropic", [sonnet, opus]);
const openaiProvider = makeProvider("openai", "OpenAI", [embedding]);

const MODEL_MODES = ["chat", "embedding", "image", "video", "audio", "moderation", "rerank"];
const PRICE_METRICS = ["input", "output", "blended"];

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

describe("Discovery routes — invalid query params return 400", () => {
	describe("GET /api/discovery/cheapest", () => {
		it("rejects an invalid boolean (?preferLocalProviders=maybe)", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&preferLocalProviders=maybe");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("preferLocalProviders");
			expect(typeof body.error).toBe("string");
			expect(body.error.length).toBeGreaterThan(0);
			expect(body.allowedValues).toEqual(["true", "false"]);
		});

		it("rejects an invalid boolean on allowCrossProvider", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&allowCrossProvider=yes");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("allowCrossProvider");
			expect(body.allowedValues).toEqual(["true", "false"]);
		});

		it("rejects a non-numeric limit (?limit=abc)", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&limit=abc");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("limit");
			expect(typeof body.error).toBe("string");
			// Numbers have no fixed allowedValues set — the field must be absent.
			expect(body.allowedValues).toBeUndefined();
		});

		it("rejects an empty limit value (?limit=)", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&limit=");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("limit");
		});

		it("rejects a non-finite numeric limit (?limit=Infinity)", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&limit=Infinity");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("limit");
		});

		it("rejects an unknown mode enum (?mode=hologram)", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&mode=hologram");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("mode");
			expect(body.allowedValues).toEqual(MODEL_MODES);
		});

		it("rejects an unknown priceMetric enum (?priceMetric=cheapest)", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&priceMetric=cheapest");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("priceMetric");
			expect(body.allowedValues).toEqual(PRICE_METRICS);
		});
	});

	describe("GET /api/discovery/binding", () => {
		it("rejects an invalid boolean on the binding route too", async () => {
			const res = await app.request("/api/discovery/binding?role=chat&preferLocalProviders=maybe");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("preferLocalProviders");
			expect(body.allowedValues).toEqual(["true", "false"]);
		});

		it("rejects a non-numeric limit on the binding route too", async () => {
			const res = await app.request("/api/discovery/binding?role=chat&limit=not-a-number");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("limit");
			expect(body.allowedValues).toBeUndefined();
		});

		it("rejects an unknown mode enum on the binding route too", async () => {
			const res = await app.request("/api/discovery/binding?role=chat&mode=telepathy");
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.param).toBe("mode");
			expect(body.allowedValues).toEqual(MODEL_MODES);
		});
	});
});

describe("Discovery routes — absent & valid params keep the happy path", () => {
	describe("GET /api/discovery/cheapest", () => {
		it("returns 200 with no filter when parsed params are absent", async () => {
			const res = await app.request("/api/discovery/cheapest?role=embeddings");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.schemaVersion).toBe(1);
			expect(body.matches[0].modelId).toBe("text-embedding-3-small");
		});

		it("accepts a valid numeric limit", async () => {
			const res = await app.request("/api/discovery/cheapest?role=embeddings&limit=2");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.matches[0].modelId).toBe("text-embedding-3-small");
		});

		it("accepts limit=0 as a finite value (not a 400)", async () => {
			const res = await app.request("/api/discovery/cheapest?role=embeddings&limit=0");
			expect(res.status).toBe(200);
		});

		it("accepts a valid boolean on preferLocalProviders", async () => {
			const res = await app.request("/api/discovery/cheapest?role=embeddings&preferLocalProviders=true");
			expect(res.status).toBe(200);
		});

		it("accepts false as a valid boolean", async () => {
			const res = await app.request("/api/discovery/cheapest?role=embeddings&allowCrossProvider=false");
			expect(res.status).toBe(200);
		});

		it("accepts a known mode enum", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&mode=chat");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.schemaVersion).toBe(1);
		});

		it("accepts a known priceMetric enum", async () => {
			const res = await app.request("/api/discovery/cheapest?role=chat&priceMetric=input");
			expect(res.status).toBe(200);
		});
	});

	describe("GET /api/discovery/binding", () => {
		it("returns 200 with valid params", async () => {
			const res = await app.request("/api/discovery/binding?role=chat&limit=3&mode=chat");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.schemaVersion).toBe(1);
			expect(Array.isArray(body.candidateModelIds)).toBe(true);
		});

		it("returns 200 when parsed params are absent", async () => {
			const res = await app.request("/api/discovery/binding?role=chat");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.schemaVersion).toBe(1);
		});
	});

	describe("GET /api/discovery (no parsed params at all)", () => {
		it("returns the snapshot with 200", async () => {
			const res = await app.request("/api/discovery");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.schemaVersion).toBe(1);
		});

		it("returns a delta with 200 without a cursor", async () => {
			const res = await app.request("/api/discovery/delta");
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body.schemaVersion).toBe(1);
		});
	});
});
