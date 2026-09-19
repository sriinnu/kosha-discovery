import { afterEach, describe, expect, it } from "vitest";
import { TypeSafeDiscoverer } from "../../src/discovery/typesafe.js";
import { getProviderDescriptor } from "../../src/provider-catalog.js";
import { CredentialResolver } from "../../src/credentials/resolver.js";
import type { CredentialResult } from "../../src/types.js";
import { mockFetch, mockFetchError, restoreFetch } from "./mock-server.js";

const validCredential: CredentialResult = { apiKey: "test-api-key", source: "env" };
const noCredential: CredentialResult = { source: "none" };

/** The live envelope shape: `models`, not the OpenAI `data` array. */
const LIVE_RESPONSE = {
	models: [
		{
			name: "jev-latest",
			description: "The latest iteration of TypeSafe's System One Model: Jev",
			release_date: "2026-09-10T18:38:01.391457+00:00",
		},
		{
			name: "jev-preview",
			description: "A preview version of `jev-latest`: should be better in most ways",
			release_date: "2026-09-10T18:39:06.057755+00:00",
		},
	],
};

afterEach(() => {
	restoreFetch();
});

describe("TypeSafeDiscoverer", () => {
	it("discovers System One models from the live envelope", async () => {
		mockFetch({ "https://api.typesafe.ai/v1/models": { status: 200, body: LIVE_RESPONSE } });

		const cards = await new TypeSafeDiscoverer().discover(validCredential);
		const latest = cards.find((card) => card.id === "jev-latest");

		expect(latest).toBeDefined();
		expect(latest?.provider).toBe("typesafe");
		expect(latest?.name).toBe("Jev (latest)");
		expect(latest?.source).toBe("api");
	});

	it("marks System One models as judgment, not chat", async () => {
		mockFetch({ "https://api.typesafe.ai/v1/models": { status: 200, body: LIVE_RESPONSE } });

		const cards = await new TypeSafeDiscoverer().discover(validCredential);

		// Jev answers a question with a typed value; it generates no text. A card
		// tagged `chat` would let a router send it prompts it cannot answer.
		expect(cards.every((card) => card.mode === "judgment")).toBe(true);
		expect(cards.every((card) => !card.capabilities.includes("chat"))).toBe(true);
		expect(cards.every((card) => card.capabilities.includes("judgment"))).toBe(true);
		expect(cards.every((card) => card.capabilities.includes("structured_output"))).toBe(true);
	});

	it("prices input only, because a typed answer bills no output", async () => {
		mockFetch({ "https://api.typesafe.ai/v1/models": { status: 200, body: LIVE_RESPONSE } });

		const cards = await new TypeSafeDiscoverer().discover(validCredential);

		// Published as $42 per billion input tokens.
		expect(cards[0].pricing?.inputPerMillion).toBeCloseTo(0.042, 6);
		expect(cards[0].pricing?.outputPerMillion).toBe(0);
		expect(cards[0].maxOutputTokens).toBe(0);
	});

	it("carries the documented 64k request / 32k state budget", async () => {
		mockFetch({ "https://api.typesafe.ai/v1/models": { status: 200, body: LIVE_RESPONSE } });

		const cards = await new TypeSafeDiscoverer().discover(validCredential);

		expect(cards[0].contextWindow).toBe(64_000);
		expect(cards[0].maxInputTokens).toBe(32_000);
	});

	it("keeps the pinned version as filler when the API lists only moving aliases", async () => {
		mockFetch({ "https://api.typesafe.ai/v1/models": { status: 200, body: LIVE_RESPONSE } });

		const cards = await new TypeSafeDiscoverer().discover(validCredential);

		// The API advertises `jev-latest` / `jev-preview` only, so a caller that
		// pinned a version must still resolve it.
		expect(cards.map((card) => card.id)).toContain("jev-1.13.0");
		expect(cards.find((card) => card.id === "jev-1.13.0")?.source).toBe("manual");
	});

	it("falls back to the curated list with no credential", async () => {
		// TypeSafe is in neither models.dev nor LiteLLM, so there is no public
		// seed to fall back through.
		const cards = await new TypeSafeDiscoverer().discover(noCredential);

		expect(cards.length).toBeGreaterThan(0);
		expect(cards.every((card) => card.source === "manual")).toBe(true);
		expect(cards.every((card) => card.mode === "judgment")).toBe(true);
	});

	it("falls back to the curated list when the API returns an empty list", async () => {
		mockFetch({ "https://api.typesafe.ai/v1/models": { status: 200, body: { models: [] } } });

		const cards = await new TypeSafeDiscoverer().discover(validCredential);

		expect(cards.length).toBeGreaterThan(0);
		expect(cards.every((card) => card.source === "manual")).toBe(true);
	});

	it("propagates a transport failure rather than masking it as no models", async () => {
		mockFetchError(new Error("network unreachable"));

		await expect(new TypeSafeDiscoverer().discover(validCredential)).rejects.toThrow();
	});

	it("is registered in the provider catalog as a native-HTTP direct provider", () => {
		expect(getProviderDescriptor("typesafe")).toMatchObject({
			canonicalProviderId: "typesafe",
			origin: "direct",
			transport: "native-http",
			defaultBaseUrl: "https://api.typesafe.ai/v1",
		});
		// `jev` is the name people reach for; it resolves to the provider too.
		expect(getProviderDescriptor("jev")?.canonicalProviderId).toBe("typesafe");
	});

	it("resolves its credential from either documented env var", async () => {
		const resolver = new CredentialResolver();
		const original = { ts: process.env.TYPESAFE_API_KEY, jev: process.env.JEV_API_KEY };
		try {
			// The SDK reads TYPESAFE_API_KEY; the key is commonly stored under the
			// model's name instead, so both have to work.
			process.env.TYPESAFE_API_KEY = "";
			process.env.JEV_API_KEY = "from-jev-var";
			expect((await resolver.resolve("typesafe")).apiKey).toBe("from-jev-var");

			process.env.TYPESAFE_API_KEY = "from-typesafe-var";
			expect((await resolver.resolve("typesafe")).apiKey).toBe("from-typesafe-var");
		} finally {
			if (original.ts === undefined) delete process.env.TYPESAFE_API_KEY;
			else process.env.TYPESAFE_API_KEY = original.ts;
			if (original.jev === undefined) delete process.env.JEV_API_KEY;
			else process.env.JEV_API_KEY = original.jev;
		}
	});
});
