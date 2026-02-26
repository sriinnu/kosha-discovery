/**
 * Tests for the VertexDiscoverer class.
 *
 * Validates the three-tier discovery strategy (REST API → gcloud CLI → static
 * fallback), access-token resolution (ADC file, refresh-token exchange, gcloud
 * CLI), model-card mapping, capability inference, and project/region resolution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VertexDiscoverer } from "../../src/discovery/vertex.js";
import type { CredentialResult } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted above all imports in vitest
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked modules so we can configure them per-test
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const mockedExecSync = vi.mocked(execSync);
const mockedReadFileSync = vi.mocked(readFileSync);

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const discoverer = new VertexDiscoverer();

/** A credential with a pre-resolved access token. */
const tokenCredential: CredentialResult = {
	accessToken: "ya29.test-access-token",
	source: "oauth",
	metadata: { projectId: "my-gcp-project", region: "us-central1" },
};

/** A credential specifying only project + region metadata (no token). */
const metadataOnlyCredential: CredentialResult = {
	source: "config",
	metadata: { projectId: "meta-project", region: "europe-west4" },
};

/** An empty credential — triggers full resolution chain. */
const noCredential: CredentialResult = { source: "none" };

/** Minimal Vertex AI REST API response. */
const apiResponse = {
	publisherModels: [
		{
			name: "publishers/google/models/gemini-2.5-pro-preview-05-06",
			displayName: "Gemini 2.5 Pro Preview",
			supportedActions: ["generateContent", "countTokens"],
		},
		{
			name: "publishers/google/models/gemini-2.0-flash",
			displayName: "Gemini 2.0 Flash",
			supportedActions: ["generateContent", "countTokens"],
		},
		{
			name: "publishers/google/models/text-embedding-005",
			displayName: "Text Embedding 005",
			supportedActions: ["embedContent"],
		},
		{
			name: "publishers/google/models/imagen-3.0-generate-002",
			displayName: "Imagen 3.0",
			supportedActions: [],
		},
	],
};

/** Minimal gcloud CLI JSON output. */
const gcloudOutput = JSON.stringify([
	{
		name: "projects/my-project/locations/us-central1/models/gemini-2.0-flash",
		displayName: "Gemini 2.0 Flash",
	},
	{
		name: "projects/my-project/locations/us-central1/models/text-embedding-005",
		displayName: "Text Embedding 005",
	},
]);

/** ADC JSON with refresh-token fields. */
const adcWithRefreshToken = JSON.stringify({
	client_id: "oauth-client-id.apps.googleusercontent.com",
	client_secret: "client-secret-value",
	refresh_token: "1//refresh-token-value",
	type: "authorized_user",
});

/** ADC JSON with a pre-issued access_token (rare but valid). */
const adcWithAccessToken = JSON.stringify({
	access_token: "ya29.direct-access-token",
	type: "authorized_user",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

function mockFetchOk(body: unknown): void {
	globalThis.fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => body,
		text: async () => JSON.stringify(body),
	})) as unknown as typeof globalThis.fetch;
}

function mockFetchFail(status = 403): void {
	globalThis.fetch = vi.fn(async () => ({
		ok: false,
		status,
		statusText: "Forbidden",
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => ({ error: { message: "Permission denied" } }),
		text: async () => JSON.stringify({ error: { message: "Permission denied" } }),
	})) as unknown as typeof globalThis.fetch;
}

function captureLastFetchUrl(): string {
	const calls = vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
	const lastInput = calls[calls.length - 1]?.[0];
	return typeof lastInput === "string" ? lastInput : String(lastInput);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	originalFetch = globalThis.fetch;
	// Suppress execSync / readFileSync by default — individual tests enable them
	mockedExecSync.mockReturnValue(Buffer.from(""));
	mockedReadFileSync.mockImplementation(() => {
		throw new Error("file not found");
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.clearAllMocks();
	// Restore process.env mutations
	delete process.env.GOOGLE_CLOUD_PROJECT;
	delete process.env.GCLOUD_PROJECT;
	delete process.env.GOOGLE_CLOUD_REGION;
	delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VertexDiscoverer — provider metadata", () => {
	it("should expose correct provider identity fields", () => {
		expect(discoverer.providerId).toBe("vertex");
		expect(discoverer.providerName).toBe("Google Vertex AI");
		expect(discoverer.baseUrl).toBe("https://{region}-aiplatform.googleapis.com");
	});
});

// ---------------------------------------------------------------------------

describe("VertexDiscoverer — static fallback", () => {
	beforeEach(() => {
		// Make all external I/O fail so the static fallback is triggered
		mockFetchFail();
		mockedExecSync.mockImplementation(() => {
			throw new Error("gcloud not found");
		});
	});

	it("should return well-known Vertex models when API and CLI are both unavailable", async () => {
		const cards = await discoverer.discover(noCredential);
		expect(cards.length).toBeGreaterThanOrEqual(5);
	});

	it("static fallback: gemini-2.5-pro-preview-05-06 has correct fields", async () => {
		const cards = await discoverer.discover(noCredential);
		const pro = cards.find((c) => c.id === "gemini-2.5-pro-preview-05-06");

		expect(pro).toBeDefined();
		expect(pro!.provider).toBe("vertex");
		expect(pro!.originProvider).toBe("google");
		expect(pro!.mode).toBe("chat");
		expect(pro!.capabilities).toContain("chat");
		expect(pro!.capabilities).toContain("vision");
		expect(pro!.capabilities).toContain("function_calling");
		expect(pro!.source).toBe("manual");
	});

	it("static fallback: text-embedding-005 has mode=embedding", async () => {
		const cards = await discoverer.discover(noCredential);
		const embed = cards.find((c) => c.id === "text-embedding-005");

		expect(embed).toBeDefined();
		expect(embed!.mode).toBe("embedding");
		expect(embed!.capabilities).toEqual(["embedding"]);
	});

	it("static fallback: imagen-3.0-generate-002 has mode=image", async () => {
		const cards = await discoverer.discover(noCredential);
		const img = cards.find((c) => c.id === "imagen-3.0-generate-002");

		expect(img).toBeDefined();
		expect(img!.mode).toBe("image");
		expect(img!.capabilities).toContain("image_generation");
	});

	it("static fallback: sets region on each card (default us-central1)", async () => {
		const cards = await discoverer.discover(noCredential);
		for (const card of cards) {
			expect(card.region).toBe("us-central1");
		}
	});

	it("static fallback: sets projectId from credential metadata", async () => {
		const cards = await discoverer.discover({ ...noCredential, metadata: { projectId: "my-project" } });
		for (const card of cards) {
			expect(card.projectId).toBe("my-project");
		}
	});

	it("static fallback: propagates custom region from credential metadata", async () => {
		const cards = await discoverer.discover(metadataOnlyCredential);
		for (const card of cards) {
			expect(card.region).toBe("europe-west4");
		}
	});
});

// ---------------------------------------------------------------------------

describe("VertexDiscoverer — REST API path", () => {
	it("should call the correct Vertex AI endpoint with Bearer token", async () => {
		mockFetchOk(apiResponse);

		await discoverer.discover(tokenCredential);

		const url = captureLastFetchUrl();
		expect(url).toContain("us-central1-aiplatform.googleapis.com");
		expect(url).toContain("my-gcp-project");
		expect(url).toContain("publishers/google/models");

		const fetchMock = vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
		const lastInit = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1] as RequestInit | undefined;
		const authHeader = (lastInit?.headers as Record<string, string>)?.Authorization;
		expect(authHeader).toBe("Bearer ya29.test-access-token");
	});

	it("should map API response to ModelCards with correct IDs (prefix stripped)", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential);

		expect(cards.find((c) => c.id === "gemini-2.5-pro-preview-05-06")).toBeDefined();
		expect(cards.find((c) => c.id === "gemini-2.0-flash")).toBeDefined();
		expect(cards.find((c) => c.id === "text-embedding-005")).toBeDefined();
		expect(cards.find((c) => c.id === "imagen-3.0-generate-002")).toBeDefined();

		// Ensure raw prefix is never present on any card ID
		for (const card of cards) {
			expect(card.id).not.toMatch(/^publishers\//);
			expect(card.id).not.toMatch(/^models\//);
		}
	});

	it("should set provider=vertex and originProvider=google on API cards", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential);

		for (const card of cards) {
			expect(card.provider).toBe("vertex");
			expect(card.originProvider).toBe("google");
		}
	});

	it("should set region and projectId from credential metadata on API cards", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential);

		for (const card of cards) {
			expect(card.region).toBe("us-central1");
			expect(card.projectId).toBe("my-gcp-project");
		}
	});

	it("should use displayName as the card name when present", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential);
		const pro = cards.find((c) => c.id === "gemini-2.5-pro-preview-05-06");

		expect(pro!.name).toBe("Gemini 2.5 Pro Preview");
	});

	it("should infer embedding mode for models with embedContent action", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential);
		const embed = cards.find((c) => c.id === "text-embedding-005");

		expect(embed!.mode).toBe("embedding");
		expect(embed!.capabilities).toEqual(["embedding"]);
	});

	it("should infer image mode for imagen models", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential);
		const img = cards.find((c) => c.id === "imagen-3.0-generate-002");

		expect(img!.mode).toBe("image");
	});

	it("should set source=api on REST API cards", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential);
		const chatCard = cards.find((c) => c.mode === "chat");

		expect(chatCard!.source).toBe("api");
	});

	it("should set defaults via makeCard (aliases, discoveredAt)", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential);
		const card = cards[0];

		expect(card.aliases).toEqual([]);
		expect(card.discoveredAt).toBeGreaterThan(0);
	});

	it("should fall through to static list when API returns non-OK status", async () => {
		mockFetchFail(403);
		mockedExecSync.mockImplementation(() => {
			throw new Error("gcloud not found");
		});

		const cards = await discoverer.discover(tokenCredential);

		// Must still return results — from the static fallback
		expect(cards.length).toBeGreaterThan(0);
		const manual = cards.find((c) => c.source === "manual");
		expect(manual).toBeDefined();
	});

	it("should handle models key in API response (alternate shape)", async () => {
		const altResponse = {
			models: [
				{
					name: "publishers/google/models/gemini-2.0-flash",
					displayName: "Gemini 2.0 Flash",
					supportedActions: ["generateContent"],
				},
			],
		};

		mockFetchOk(altResponse);

		const cards = await discoverer.discover(tokenCredential);
		expect(cards).toHaveLength(1);
		expect(cards[0].id).toBe("gemini-2.0-flash");
	});
});

// ---------------------------------------------------------------------------

describe("VertexDiscoverer — capability and mode inference", () => {
	it("should add vision + function_calling for gemini pro models", async () => {
		mockFetchOk({
			publisherModels: [
				{
					name: "publishers/google/models/gemini-2.5-pro-preview-05-06",
					displayName: "Gemini 2.5 Pro Preview",
					supportedActions: ["generateContent"],
				},
			],
		});

		const cards = await discoverer.discover(tokenCredential);
		const pro = cards[0];

		expect(pro.capabilities).toContain("vision");
		expect(pro.capabilities).toContain("function_calling");
		expect(pro.capabilities).toContain("code");
		expect(pro.capabilities).toContain("nlu");
	});

	it("should add vision + function_calling for gemini flash models", async () => {
		mockFetchOk({
			publisherModels: [
				{
					name: "publishers/google/models/gemini-2.0-flash",
					displayName: "Gemini 2.0 Flash",
					supportedActions: ["generateContent"],
				},
			],
		});

		const cards = await discoverer.discover(tokenCredential);
		expect(cards[0].capabilities).toContain("vision");
		expect(cards[0].capabilities).toContain("function_calling");
	});

	it("should return only [embedding] capabilities for embedding models", async () => {
		mockFetchOk({
			publisherModels: [
				{
					name: "publishers/google/models/text-embedding-005",
					displayName: "Text Embedding 005",
					supportedActions: ["embedContent"],
				},
			],
		});

		const cards = await discoverer.discover(tokenCredential);
		expect(cards[0].capabilities).toEqual(["embedding"]);
	});

	it("should return [image_generation] for imagen models", async () => {
		mockFetchOk({
			publisherModels: [
				{
					name: "publishers/google/models/imagen-3.0-generate-002",
					displayName: "Imagen 3.0",
					supportedActions: [],
				},
			],
		});

		const cards = await discoverer.discover(tokenCredential);
		expect(cards[0].capabilities).toContain("image_generation");
	});
});

// ---------------------------------------------------------------------------

describe("VertexDiscoverer — gcloud CLI fallback", () => {
	it("should parse gcloud CLI JSON output and return ModelCards", async () => {
		// API fails → CLI succeeds
		mockFetchFail(403);
		mockedReadFileSync.mockImplementation(() => {
			throw new Error("no ADC");
		});

		mockedExecSync.mockImplementation((cmd: string) => {
			// Token commands return empty; model list returns data
			if (String(cmd).includes("ai models list")) {
				return Buffer.from(gcloudOutput);
			}
			return Buffer.from("");
		});

		const cards = await discoverer.discover(metadataOnlyCredential);

		expect(cards.length).toBeGreaterThan(0);
		const flash = cards.find((c) => c.id === "gemini-2.0-flash");
		expect(flash).toBeDefined();
		expect(flash!.provider).toBe("vertex");
		expect(flash!.originProvider).toBe("google");
		expect(flash!.region).toBe("europe-west4");
		expect(flash!.projectId).toBe("meta-project");
	});

	it("should extract bare model ID from full gcloud resource path", async () => {
		mockFetchFail(403);
		mockedReadFileSync.mockImplementation(() => {
			throw new Error("no ADC");
		});

		mockedExecSync.mockImplementation((cmd: string) => {
			if (String(cmd).includes("ai models list")) {
				return Buffer.from(gcloudOutput);
			}
			return Buffer.from("");
		});

		const cards = await discoverer.discover(metadataOnlyCredential);

		for (const card of cards) {
			expect(card.id).not.toMatch(/^projects\//);
			expect(card.id).not.toMatch(/^locations\//);
		}
	});

	it("should fall through to static fallback if gcloud CLI errors", async () => {
		mockFetchFail(403);
		mockedReadFileSync.mockImplementation(() => {
			throw new Error("no ADC");
		});
		mockedExecSync.mockImplementation(() => {
			throw new Error("gcloud: command not found");
		});

		const cards = await discoverer.discover(metadataOnlyCredential);

		// Static fallback must kick in
		expect(cards.length).toBeGreaterThan(0);
		const manual = cards.find((c) => c.source === "manual");
		expect(manual).toBeDefined();
	});
});

// ---------------------------------------------------------------------------

describe("VertexDiscoverer — access token resolution", () => {
	it("should use credential.accessToken when already present", async () => {
		const token = await discoverer.getAccessToken({
			accessToken: "ya29.direct-token",
			source: "oauth",
		});

		expect(token).toBe("ya29.direct-token");
		// readFileSync and execSync must not be called
		expect(mockedReadFileSync).not.toHaveBeenCalled();
		expect(mockedExecSync).not.toHaveBeenCalled();
	});

	it("should read access_token directly from ADC file when present", async () => {
		mockedReadFileSync.mockReturnValue(adcWithAccessToken as unknown as Buffer);

		const token = await discoverer.getAccessToken(noCredential);

		expect(token).toBe("ya29.direct-access-token");
		expect(mockedExecSync).not.toHaveBeenCalled();
	});

	it("should exchange refresh token for access token via OAuth endpoint", async () => {
		mockedReadFileSync.mockReturnValue(adcWithRefreshToken as unknown as Buffer);

		// Mock the OAuth token endpoint
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				access_token: "ya29.exchanged-token",
				expires_in: 3600,
				token_type: "Bearer",
			}),
		})) as unknown as typeof globalThis.fetch;

		const token = await discoverer.getAccessToken(noCredential);

		expect(token).toBe("ya29.exchanged-token");
		// Verify it called the Google OAuth endpoint
		const fetchMock = vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
		const lastUrl = fetchMock.mock.calls[0]?.[0];
		expect(String(lastUrl)).toContain("oauth2.googleapis.com/token");
	});

	it("should fall back to gcloud auth print-access-token when ADC file is missing", async () => {
		mockedReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT: no such file");
		});
		mockedExecSync.mockReturnValue(Buffer.from("ya29.gcloud-token\n"));

		const token = await discoverer.getAccessToken(noCredential);

		expect(token).toBe("ya29.gcloud-token");
		expect(mockedExecSync).toHaveBeenCalledWith(
			"gcloud auth print-access-token",
			expect.objectContaining({ timeout: 8_000 }),
		);
	});

	it("should return undefined when all token strategies fail", async () => {
		mockedReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		mockedExecSync.mockImplementation(() => {
			throw new Error("gcloud not found");
		});

		const token = await discoverer.getAccessToken(noCredential);

		expect(token).toBeUndefined();
	});

	it("should use GOOGLE_APPLICATION_CREDENTIALS env var for ADC path", async () => {
		const customPath = "/custom/path/credentials.json";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = customPath;

		mockedReadFileSync.mockReturnValue(adcWithAccessToken as unknown as Buffer);

		const token = await discoverer.getAccessToken(noCredential);

		expect(token).toBe("ya29.direct-access-token");
		expect(mockedReadFileSync).toHaveBeenCalledWith(customPath, "utf8");
	});

	it("should return undefined when OAuth refresh token exchange fails", async () => {
		mockedReadFileSync.mockReturnValue(adcWithRefreshToken as unknown as Buffer);
		mockedExecSync.mockImplementation(() => {
			throw new Error("gcloud not found");
		});

		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 401,
			json: async () => ({ error: "invalid_grant" }),
		})) as unknown as typeof globalThis.fetch;

		const token = await discoverer.getAccessToken(noCredential);

		expect(token).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------

describe("VertexDiscoverer — project ID resolution", () => {
	it("should prefer credential.metadata.projectId over env vars", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "env-project";
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(tokenCredential); // metadata.projectId = "my-gcp-project"

		for (const card of cards) {
			expect(card.projectId).toBe("my-gcp-project");
		}
	});

	it("should use GOOGLE_CLOUD_PROJECT env var when credential has no metadata", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "env-project";
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover({
			accessToken: "ya29.test-token",
			source: "oauth",
		});

		for (const card of cards) {
			expect(card.projectId).toBe("env-project");
		}
	});

	it("should use GCLOUD_PROJECT env var as second env fallback", async () => {
		process.env.GCLOUD_PROJECT = "gcloud-env-project";
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover({
			accessToken: "ya29.test-token",
			source: "oauth",
		});

		for (const card of cards) {
			expect(card.projectId).toBe("gcloud-env-project");
		}
	});

	it("should call gcloud config get-value project when no env var is set", async () => {
		mockedExecSync.mockImplementation((cmd: string) => {
			if (String(cmd).includes("config get-value project")) {
				return Buffer.from("gcloud-config-project\n");
			}
			// Token and model-list commands can fail — we just test project resolution
			throw new Error("command failed");
		});

		// API will fail; we just want to verify the gcloud call was made
		mockFetchFail(403);

		await discoverer.discover(noCredential);

		const configCall = mockedExecSync.mock.calls.find((c) => String(c[0]).includes("config get-value project"));
		expect(configCall).toBeDefined();
	});

	it("should handle gcloud config returning (unset) gracefully", async () => {
		mockedExecSync.mockImplementation((cmd: string) => {
			if (String(cmd).includes("config get-value project")) {
				return Buffer.from("(unset)\n");
			}
			throw new Error("command failed");
		});

		mockFetchFail(403);

		// Should not throw — should return static fallback with undefined projectId
		const cards = await discoverer.discover(noCredential);
		expect(cards.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------

describe("VertexDiscoverer — region handling", () => {
	it("should use credential.metadata.region when provided", async () => {
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover(metadataOnlyCredential); // region: europe-west4

		const fetchMock = vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
		const url = String(fetchMock.mock.calls[0]?.[0]);
		// When API succeeds, URL must use the correct region
		// If it fell back, verify via card.region
		if (cards.some((c) => c.source === "api")) {
			expect(url).toContain("europe-west4");
		}

		for (const card of cards) {
			expect(card.region).toBe("europe-west4");
		}
	});

	it("should use GOOGLE_CLOUD_REGION env var when credential has no region", async () => {
		process.env.GOOGLE_CLOUD_REGION = "asia-east1";
		mockFetchOk(apiResponse);

		const cards = await discoverer.discover({
			accessToken: "ya29.test-token",
			source: "oauth",
			metadata: { projectId: "my-project" },
		});

		for (const card of cards) {
			expect(card.region).toBe("asia-east1");
		}
	});

	it("should default to us-central1 when no region is specified anywhere", async () => {
		mockFetchFail(403);
		mockedExecSync.mockImplementation(() => {
			throw new Error("gcloud not found");
		});

		const cards = await discoverer.discover(noCredential);

		for (const card of cards) {
			expect(card.region).toBe("us-central1");
		}
	});
});
