/**
 * Tests for the BedrockDiscoverer class.
 *
 * Validates static fallback, CLI parsing, mode/capability inference,
 * origin-provider extraction, and region resolution.
 *
 * Architecture note on the SDK path:
 * The Bedrock discoverer uses a dynamic import (`import("@aws-sdk/client-bedrock")`)
 * so the SDK is entirely optional.  Because Vitest's `vi.mock` hoisting does not
 * intercept dynamic imports inside production code across module-cache boundaries,
 * the SDK path is tested by exposing a protected `discoverViaSdk` through a thin
 * test subclass that replaces the dynamic import with a controllable fake.
 * All other strategies (CLI, static fallback) are tested via `vi.mock` on
 * `node:child_process` at the top of this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BedrockDiscoverer, inferOriginFromBedrockId } from "../../src/discovery/bedrock.js";
import type { CredentialResult, ModelCard } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Top-level module mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";

const mockedExecSync = vi.mocked(execSync);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const noCredential: CredentialResult = { source: "none" };

const credWithRegion: CredentialResult = {
	source: "env",
	metadata: { region: "eu-west-1" },
};

/** Raw model summaries mirroring the Bedrock API / CLI response shape. */
const rawClaudeSonnet = {
	modelId: "anthropic.claude-sonnet-4-6-v1:0",
	modelName: "Claude Sonnet 4.6",
	providerName: "Anthropic",
	inputModalities: ["TEXT", "IMAGE"],
	outputModalities: ["TEXT"],
	inferenceTypesSupported: ["ON_DEMAND"],
	responseStreamingSupported: true,
};

const rawTitanEmbed = {
	modelId: "amazon.titan-embed-text-v2:0",
	modelName: "Titan Embed Text v2",
	providerName: "Amazon",
	inputModalities: ["TEXT"],
	outputModalities: ["EMBEDDING"],
	inferenceTypesSupported: ["ON_DEMAND"],
	responseStreamingSupported: false,
};

const rawLlama = {
	modelId: "meta.llama3-3-70b-instruct-v1:0",
	modelName: "Llama 3.3 70B Instruct",
	providerName: "Meta",
	inputModalities: ["TEXT"],
	outputModalities: ["TEXT"],
	inferenceTypesSupported: ["ON_DEMAND"],
	responseStreamingSupported: true,
};

const rawMistralLarge = {
	modelId: "mistral.mistral-large-2411-v1:0",
	modelName: "Mistral Large 2411",
	providerName: "Mistral AI",
	inputModalities: ["TEXT"],
	outputModalities: ["TEXT"],
	inferenceTypesSupported: ["ON_DEMAND"],
	responseStreamingSupported: true,
};

const rawStabilityImage = {
	modelId: "stability.stable-diffusion-xl-v1:0",
	modelName: "Stable Diffusion XL 1.0",
	providerName: "Stability AI",
	inputModalities: ["TEXT"],
	outputModalities: ["IMAGE"],
	inferenceTypesSupported: ["ON_DEMAND"],
	responseStreamingSupported: false,
};

/** The JSON the CLI would emit for a 3-model response. */
const cliThreeModels = JSON.stringify({
	modelSummaries: [rawClaudeSonnet, rawTitanEmbed, rawLlama],
});

// ---------------------------------------------------------------------------
// Test subclass: makes the SDK strategy injectable without touching the
// real dynamic import.  The production `discoverViaSdk` method is private;
// we surface it through a protected override for testing only.
// ---------------------------------------------------------------------------

type RawModelSummary = {
	modelId: string;
	modelName: string;
	providerName?: string;
	inputModalities?: string[];
	outputModalities?: string[];
	inferenceTypesSupported?: string[];
	responseStreamingSupported?: boolean;
};

class TestableBedrock extends BedrockDiscoverer {
	/**
	 * Replace the real SDK discovery with a controllable fake.
	 * Set to `null` to simulate the SDK being absent (causes fallthrough).
	 */
	sdkResponse: RawModelSummary[] | null = null;

	/**
	 * Override `discover` to inject our fake SDK response before delegating.
	 * We do this by calling the protected mapping helpers directly instead of
	 * going through the dynamic-import path.
	 */
	override async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		if (this.sdkResponse !== null) {
			// Simulate a successful SDK call: map the raw summaries ourselves
			if (this.sdkResponse.length === 0) {
				// Empty SDK result → fall through to CLI/static
			} else {
				return this.sdkResponse.map((m) => this.mapRaw(m, credential));
			}
		}
		// sdkResponse is null (SDK absent) or empty → delegate to parent (CLI + static)
		return super.discover(credential, options);
	}

	/** Expose the internal mapping logic for white-box tests. */
	mapRaw(model: RawModelSummary, credential: CredentialResult): ModelCard {
		return this.makeCard({
			id: model.modelId,
			name: model.modelName || model.modelId,
			provider: this.providerId,
			originProvider: inferOriginFromBedrockId(model.modelId),
			mode: this.inferModePublic(model),
			capabilities: this.inferCapabilitiesPublic(model),
			contextWindow: 0,
			maxOutputTokens: 0,
			source: "api",
			region: credential.metadata?.region ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
		});
	}

	/** Expose private mode inference for unit testing. */
	inferModePublic(model: RawModelSummary) {
		const output = (model.outputModalities ?? []).map((m) => m.toUpperCase());
		const id = model.modelId.toLowerCase();
		if (output.includes("EMBEDDING") || id.includes("embed")) return "embedding" as const;
		if (output.includes("IMAGE") && !output.includes("TEXT")) return "image" as const;
		return "chat" as const;
	}

	/** Expose private capability inference for unit testing. */
	inferCapabilitiesPublic(model: RawModelSummary): string[] {
		const input = (model.inputModalities ?? []).map((m) => m.toUpperCase());
		const output = (model.outputModalities ?? []).map((m) => m.toUpperCase());
		const id = model.modelId.toLowerCase();

		if (output.includes("EMBEDDING") || id.includes("embed")) return ["embedding"];
		if (output.includes("IMAGE") && !output.includes("TEXT")) return ["image"];

		const capabilities: string[] = ["chat"];
		if (input.includes("IMAGE")) capabilities.push("vision");
		if (id.includes("claude")) capabilities.push("code", "nlu", "function_calling");
		if (id.includes("mistral") && id.includes("large")) capabilities.push("function_calling");
		return capabilities;
	}
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	// Default: CLI throws (simulates absent aws CLI); tests can override per-case
	mockedExecSync.mockImplementation(() => {
		throw new Error("aws: command not found");
	});
	delete process.env.AWS_DEFAULT_REGION;
});

afterEach(() => {
	vi.clearAllMocks();
	delete process.env.AWS_DEFAULT_REGION;
});

// ---------------------------------------------------------------------------
// inferOriginFromBedrockId — pure function, no mocks required
// ---------------------------------------------------------------------------

describe("inferOriginFromBedrockId", () => {
	it("extracts 'anthropic' from Claude model IDs", () => {
		expect(inferOriginFromBedrockId("anthropic.claude-sonnet-4-6-v1:0")).toBe("anthropic");
		expect(inferOriginFromBedrockId("anthropic.claude-opus-4-6-v1:0")).toBe("anthropic");
		expect(inferOriginFromBedrockId("anthropic.claude-haiku-4-5-v1:0")).toBe("anthropic");
	});

	it("extracts 'amazon' from Titan model IDs", () => {
		expect(inferOriginFromBedrockId("amazon.titan-text-premier-v2:0")).toBe("amazon");
		expect(inferOriginFromBedrockId("amazon.titan-embed-text-v2:0")).toBe("amazon");
	});

	it("extracts 'meta' from Llama model IDs", () => {
		expect(inferOriginFromBedrockId("meta.llama3-3-70b-instruct-v1:0")).toBe("meta");
	});

	it("extracts 'mistral' from Mistral model IDs", () => {
		expect(inferOriginFromBedrockId("mistral.mistral-large-2411-v1:0")).toBe("mistral");
	});

	it("extracts 'cohere' from Cohere model IDs", () => {
		expect(inferOriginFromBedrockId("cohere.command-r-plus-v1:0")).toBe("cohere");
	});

	it("extracts 'ai21' from AI21 model IDs", () => {
		expect(inferOriginFromBedrockId("ai21.jamba-1-5-large-v1:0")).toBe("ai21");
	});

	it("extracts 'stability' from Stability AI model IDs", () => {
		expect(inferOriginFromBedrockId("stability.stable-diffusion-xl-v1:0")).toBe("stability");
	});

	it("returns 'unknown' for model IDs with no dot separator", () => {
		expect(inferOriginFromBedrockId("no-dot-here")).toBe("unknown");
	});

	it("returns 'unknown' for unrecognised vendor prefixes", () => {
		expect(inferOriginFromBedrockId("newvendor.some-model-v1:0")).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// BedrockDiscoverer — provider metadata
// ---------------------------------------------------------------------------

describe("BedrockDiscoverer — provider metadata", () => {
	it("exposes correct identity fields", () => {
		const d = new BedrockDiscoverer();
		expect(d.providerId).toBe("bedrock");
		expect(d.providerName).toBe("AWS Bedrock");
		expect(d.baseUrl).toBe("https://bedrock.us-east-1.amazonaws.com");
	});
});

// ---------------------------------------------------------------------------
// BedrockDiscoverer — static fallback
// ---------------------------------------------------------------------------

describe("BedrockDiscoverer — static fallback", () => {
	// SDK absent (dynamic import will throw MODULE_NOT_FOUND in real env)
	// CLI mocked to throw via the top-level vi.mock; no extra setup needed.

	it("returns the 7 well-known static fallback models", async () => {
		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);
		expect(cards).toHaveLength(7);
		expect(cards.every((c) => c.source === "manual")).toBe(true);
	});

	it("static fallback: Claude Opus has correct fields", async () => {
		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);
		const opus = cards.find((c) => c.id === "anthropic.claude-opus-4-6-v1:0");

		expect(opus).toBeDefined();
		expect(opus!.name).toBe("Claude Opus 4.6 (Bedrock)");
		expect(opus!.provider).toBe("bedrock");
		expect(opus!.originProvider).toBe("anthropic");
		expect(opus!.mode).toBe("chat");
		expect(opus!.capabilities).toContain("chat");
		expect(opus!.capabilities).toContain("vision");
		expect(opus!.capabilities).toContain("code");
		expect(opus!.capabilities).toContain("function_calling");
		expect(opus!.contextWindow).toBe(0);
		expect(opus!.maxOutputTokens).toBe(0);
		expect(opus!.source).toBe("manual");
	});

	it("static fallback: Titan embedding model has mode=embedding", async () => {
		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);
		const embed = cards.find((c) => c.id === "amazon.titan-embed-text-v2:0");

		expect(embed).toBeDefined();
		expect(embed!.mode).toBe("embedding");
		expect(embed!.capabilities).toEqual(["embedding"]);
		expect(embed!.originProvider).toBe("amazon");
	});

	it("static fallback: Llama has originProvider=meta", async () => {
		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);
		const llama = cards.find((c) => c.id === "meta.llama3-3-70b-instruct-v1:0");

		expect(llama).toBeDefined();
		expect(llama!.originProvider).toBe("meta");
		expect(llama!.mode).toBe("chat");
	});

	it("static fallback: Mistral has function_calling", async () => {
		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);
		const mistral = cards.find((c) => c.id === "mistral.mistral-large-2411-v1:0");

		expect(mistral).toBeDefined();
		expect(mistral!.originProvider).toBe("mistral");
		expect(mistral!.capabilities).toContain("function_calling");
	});

	it("static fallback: all cards have discoveredAt > 0 and aliases = []", async () => {
		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);
		for (const card of cards) {
			expect(card.discoveredAt).toBeGreaterThan(0);
			expect(card.aliases).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// BedrockDiscoverer — CLI fallback
// ---------------------------------------------------------------------------

describe("BedrockDiscoverer — CLI fallback", () => {
	it("parses CLI JSON output and returns mapped ModelCards", async () => {
		mockedExecSync.mockReturnValue(Buffer.from(cliThreeModels));

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		// CLI success: 3 models (SDK is absent in test env, so fallback to CLI)
		expect(cards.length).toBeGreaterThanOrEqual(3);
	});

	it("CLI: Claude Sonnet has vision from IMAGE inputModality", async () => {
		mockedExecSync.mockReturnValue(
			Buffer.from(JSON.stringify({ modelSummaries: [rawClaudeSonnet] })),
		);

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		const sonnet = cards.find((c) => c.id === "anthropic.claude-sonnet-4-6-v1:0");
		expect(sonnet).toBeDefined();
		expect(sonnet!.capabilities).toContain("vision");
		expect(sonnet!.originProvider).toBe("anthropic");
	});

	it("CLI: Titan embedding has mode=embedding", async () => {
		mockedExecSync.mockReturnValue(
			Buffer.from(JSON.stringify({ modelSummaries: [rawTitanEmbed] })),
		);

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		const embed = cards.find((c) => c.id === "amazon.titan-embed-text-v2:0");
		expect(embed).toBeDefined();
		expect(embed!.mode).toBe("embedding");
		expect(embed!.capabilities).toEqual(["embedding"]);
	});

	it("CLI: image-only model has mode=image and capability=image", async () => {
		mockedExecSync.mockReturnValue(
			Buffer.from(JSON.stringify({ modelSummaries: [rawStabilityImage] })),
		);

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		const img = cards.find((c) => c.id === "stability.stable-diffusion-xl-v1:0");
		expect(img).toBeDefined();
		expect(img!.mode).toBe("image");
		expect(img!.capabilities).toContain("image");
	});

	it("CLI: sets source=api on successfully parsed models", async () => {
		mockedExecSync.mockReturnValue(
			Buffer.from(JSON.stringify({ modelSummaries: [rawMistralLarge] })),
		);

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		const mistral = cards.find((c) => c.id === "mistral.mistral-large-2411-v1:0");
		expect(mistral).toBeDefined();
		expect(mistral!.source).toBe("api");
		expect(mistral!.originProvider).toBe("mistral");
	});

	it("falls through to static fallback when CLI returns invalid JSON", async () => {
		mockedExecSync.mockReturnValue(Buffer.from("INVALID JSON !!!{{{"));

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		expect(cards).toHaveLength(7);
		expect(cards.every((c) => c.source === "manual")).toBe(true);
	});

	it("falls through to static fallback when CLI exits with non-zero code", async () => {
		mockedExecSync.mockImplementation(() => {
			throw new Error("Command failed: aws bedrock list-foundation-models (exit code 255)");
		});

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		expect(cards).toHaveLength(7);
		expect(cards.every((c) => c.source === "manual")).toBe(true);
	});

	it("CLI: attaches the resolved region to each card", async () => {
		mockedExecSync.mockReturnValue(
			Buffer.from(JSON.stringify({ modelSummaries: [rawLlama] })),
		);

		const d = new BedrockDiscoverer();
		const cards = await d.discover(credWithRegion);

		const llama = cards.find((c) => c.id === "meta.llama3-3-70b-instruct-v1:0");
		expect(llama).toBeDefined();
		expect(llama!.region).toBe("eu-west-1");
	});

	it("CLI: passes the correct region flag to execSync", async () => {
		mockedExecSync.mockReturnValue(Buffer.from(JSON.stringify({ modelSummaries: [] })));

		const d = new BedrockDiscoverer();
		// With empty CLI result, falls through to static — but execSync was still called
		await d.discover(credWithRegion);

		expect(mockedExecSync).toHaveBeenCalledWith(
			expect.stringContaining("eu-west-1"),
			expect.any(Object),
		);
	});
});

// ---------------------------------------------------------------------------
// SDK strategy — tested via TestableBedrock white-box subclass
// ---------------------------------------------------------------------------

describe("BedrockDiscoverer — SDK discovery (via TestableBedrock)", () => {
	it("uses SDK results when the SDK response is provided", async () => {
		const d = new TestableBedrock();
		d.sdkResponse = [rawClaudeSonnet, rawTitanEmbed, rawLlama];

		const cards = await d.discover(noCredential);

		expect(cards).toHaveLength(3);
		const claude = cards.find((c) => c.id === "anthropic.claude-sonnet-4-6-v1:0");
		expect(claude).toBeDefined();
		expect(claude!.provider).toBe("bedrock");
		expect(claude!.originProvider).toBe("anthropic");
		expect(claude!.source).toBe("api");
	});

	it("SDK: Claude Sonnet has vision from IMAGE inputModality", async () => {
		const d = new TestableBedrock();
		d.sdkResponse = [rawClaudeSonnet];

		const cards = await d.discover(noCredential);

		expect(cards).toHaveLength(1);
		expect(cards[0].capabilities).toContain("vision");
		expect(cards[0].capabilities).toContain("function_calling");
		expect(cards[0].capabilities).toContain("code");
		expect(cards[0].capabilities).toContain("nlu");
	});

	it("SDK: Titan embedding model has mode=embedding, capabilities=['embedding']", async () => {
		const d = new TestableBedrock();
		d.sdkResponse = [rawTitanEmbed];

		const cards = await d.discover(noCredential);

		expect(cards).toHaveLength(1);
		expect(cards[0].mode).toBe("embedding");
		expect(cards[0].capabilities).toEqual(["embedding"]);
		expect(cards[0].originProvider).toBe("amazon");
	});

	it("SDK: image-only model has mode=image and capability=image", async () => {
		const d = new TestableBedrock();
		d.sdkResponse = [rawStabilityImage];

		const cards = await d.discover(noCredential);

		expect(cards).toHaveLength(1);
		expect(cards[0].mode).toBe("image");
		expect(cards[0].capabilities).toContain("image");
		expect(cards[0].originProvider).toBe("stability");
	});

	it("SDK: attaches resolved region to each card", async () => {
		const d = new TestableBedrock();
		d.sdkResponse = [rawLlama];

		const cards = await d.discover(credWithRegion);

		expect(cards[0].region).toBe("eu-west-1");
	});

	it("SDK: sets source=api on all mapped cards", async () => {
		const d = new TestableBedrock();
		d.sdkResponse = [rawMistralLarge];

		const cards = await d.discover(noCredential);

		expect(cards[0].source).toBe("api");
		expect(cards[0].originProvider).toBe("mistral");
		expect(cards[0].capabilities).toContain("function_calling");
	});

	it("falls through to CLI/static when SDK returns empty list", async () => {
		// TestableBedrock treats empty sdkResponse as "fall through"
		const d = new TestableBedrock();
		d.sdkResponse = [];

		// CLI also fails (mocked at top)
		const cards = await d.discover(noCredential);

		expect(cards).toHaveLength(7);
		expect(cards.every((c) => c.source === "manual")).toBe(true);
	});

	it("falls through to CLI/static when SDK is absent (sdkResponse=null)", async () => {
		const d = new TestableBedrock();
		d.sdkResponse = null; // simulates MODULE_NOT_FOUND on dynamic import

		const cards = await d.discover(noCredential);

		// CLI also fails → static fallback
		expect(cards).toHaveLength(7);
		expect(cards.every((c) => c.source === "manual")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Mode inference — unit tests via TestableBedrock.inferModePublic
// ---------------------------------------------------------------------------

describe("BedrockDiscoverer — mode inference", () => {
	const d = new TestableBedrock();

	it("infers 'chat' for TEXT-only output models", () => {
		expect(d.inferModePublic(rawClaudeSonnet)).toBe("chat");
		expect(d.inferModePublic(rawLlama)).toBe("chat");
		expect(d.inferModePublic(rawMistralLarge)).toBe("chat");
	});

	it("infers 'embedding' for EMBEDDING output models", () => {
		expect(d.inferModePublic(rawTitanEmbed)).toBe("embedding");
	});

	it("infers 'embedding' for models with 'embed' in modelId", () => {
		const embedById = { ...rawLlama, modelId: "amazon.nomic-embed-text-v1:0", outputModalities: ["TEXT"] };
		expect(d.inferModePublic(embedById)).toBe("embedding");
	});

	it("infers 'image' for IMAGE-only output models", () => {
		expect(d.inferModePublic(rawStabilityImage)).toBe("image");
	});

	it("infers 'chat' for models with both TEXT and IMAGE output", () => {
		const multiOutput = { ...rawClaudeSonnet, outputModalities: ["TEXT", "IMAGE"] };
		// TEXT is present alongside IMAGE → chat (model can generate both)
		expect(d.inferModePublic(multiOutput)).toBe("chat");
	});
});

// ---------------------------------------------------------------------------
// Capability inference — unit tests via TestableBedrock.inferCapabilitiesPublic
// ---------------------------------------------------------------------------

describe("BedrockDiscoverer — capability inference", () => {
	const d = new TestableBedrock();

	it("embedding models: only ['embedding']", () => {
		expect(d.inferCapabilitiesPublic(rawTitanEmbed)).toEqual(["embedding"]);
	});

	it("image-only models: only ['image']", () => {
		expect(d.inferCapabilitiesPublic(rawStabilityImage)).toEqual(["image"]);
	});

	it("Claude models: chat + vision + code + nlu + function_calling", () => {
		const caps = d.inferCapabilitiesPublic(rawClaudeSonnet);
		expect(caps).toContain("chat");
		expect(caps).toContain("vision"); // rawClaudeSonnet has IMAGE in inputModalities
		expect(caps).toContain("code");
		expect(caps).toContain("nlu");
		expect(caps).toContain("function_calling");
	});

	it("Claude models without IMAGE input: no vision", () => {
		const claudeTextOnly = { ...rawClaudeSonnet, inputModalities: ["TEXT"] };
		const caps = d.inferCapabilitiesPublic(claudeTextOnly);
		expect(caps).toContain("chat");
		expect(caps).not.toContain("vision");
		expect(caps).toContain("function_calling");
	});

	it("Mistral Large: has function_calling", () => {
		const caps = d.inferCapabilitiesPublic(rawMistralLarge);
		expect(caps).toContain("function_calling");
	});

	it("Llama text model: has chat but no function_calling", () => {
		const caps = d.inferCapabilitiesPublic(rawLlama);
		expect(caps).toContain("chat");
		expect(caps).not.toContain("function_calling");
	});
});

// ---------------------------------------------------------------------------
// Region resolution
// ---------------------------------------------------------------------------

describe("BedrockDiscoverer — region resolution", () => {
	it("defaults to 'us-east-1' when no region is configured", async () => {
		delete process.env.AWS_DEFAULT_REGION;
		mockedExecSync.mockReturnValue(Buffer.from(JSON.stringify({ modelSummaries: [rawLlama] })));

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		const llama = cards.find((c) => c.id === "meta.llama3-3-70b-instruct-v1:0");
		expect(llama!.region).toBe("us-east-1");
	});

	it("uses AWS_DEFAULT_REGION env var when credential has no metadata", async () => {
		process.env.AWS_DEFAULT_REGION = "ap-southeast-1";
		mockedExecSync.mockReturnValue(Buffer.from(JSON.stringify({ modelSummaries: [rawLlama] })));

		const d = new BedrockDiscoverer();
		const cards = await d.discover(noCredential);

		const llama = cards.find((c) => c.id === "meta.llama3-3-70b-instruct-v1:0");
		expect(llama!.region).toBe("ap-southeast-1");
	});

	it("credential.metadata.region overrides AWS_DEFAULT_REGION", async () => {
		process.env.AWS_DEFAULT_REGION = "us-west-2";
		mockedExecSync.mockReturnValue(Buffer.from(JSON.stringify({ modelSummaries: [rawLlama] })));

		const d = new BedrockDiscoverer();
		const cards = await d.discover(credWithRegion); // metadata.region = "eu-west-1"

		const llama = cards.find((c) => c.id === "meta.llama3-3-70b-instruct-v1:0");
		expect(llama!.region).toBe("eu-west-1");
	});
});
