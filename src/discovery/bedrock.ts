/**
 * kosha-discovery — AWS Bedrock model discoverer.
 *
 * Resolution strategy (in order):
 * 1. AWS SDK (`@aws-sdk/client-bedrock`) — if installed in the host project.
 * 2. AWS CLI fallback (`aws bedrock list-foundation-models --output json`).
 * 3. Static fallback list of well-known Bedrock foundation models (Feb 2026).
 *
 * Credentials use the standard AWS credential chain:
 * environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`),
 * `~/.aws/credentials`, EC2 / ECS instance-metadata IAM roles, etc.
 * No explicit credential is required by this discoverer — the SDK and CLI
 * both pick up the ambient credential automatically.
 *
 * @module
 */

import { execSync } from "node:child_process";
import type { CredentialResult, ModelCard, ModelMode } from "../types.js";
import { BaseDiscoverer } from "./base.js";

// ---------------------------------------------------------------------------
// Internal types that mirror the AWS SDK / CLI response shapes
// ---------------------------------------------------------------------------

/**
 * A single foundation model entry as returned by
 * `ListFoundationModelsCommand` or the equivalent CLI output.
 */
interface BedrockFoundationModel {
	modelId: string;
	modelName: string;
	providerName?: string;
	inputModalities?: string[];
	outputModalities?: string[];
	/** Supported inference types: "ON_DEMAND" | "PROVISIONED" */
	inferenceTypesSupported?: string[];
	responseStreamingSupported?: boolean;
	customizationsSupported?: string[];
}

/** Wrapper shape returned by the AWS SDK `ListFoundationModelsCommand`. */
interface BedrockListResponse {
	modelSummaries?: BedrockFoundationModel[];
}

/** Wrapper shape returned by `aws bedrock list-foundation-models --output json`. */
interface BedrockCliResponse {
	modelSummaries?: BedrockFoundationModel[];
}

// ---------------------------------------------------------------------------
// Vendor prefix → originProvider mapping
// ---------------------------------------------------------------------------

/**
 * Maps the Bedrock model-ID vendor prefix to the canonical origin provider.
 *
 * Bedrock model IDs follow the pattern `{vendor}.{model-family}-v{n}:{variant}`,
 * e.g. `anthropic.claude-opus-4-6-v1:0`, `amazon.titan-text-premier-v2:0`.
 */
const VENDOR_TO_ORIGIN: Record<string, string> = {
	anthropic: "anthropic",
	amazon: "amazon",
	meta: "meta",
	mistral: "mistral",
	cohere: "cohere",
	ai21: "ai21",
	stability: "stability",
	"amazon-bedrock-preview": "amazon",
};

// ---------------------------------------------------------------------------
// Static fallback catalogue (Feb 2026)
// ---------------------------------------------------------------------------

/**
 * A minimal set of well-known Bedrock foundation models used when neither
 * the SDK nor the CLI is available.  Context windows and output limits are
 * intentionally set to 0 so that the litellm enrichment pass can fill them in.
 */
const STATIC_MODELS: ReadonlyArray<
	Pick<ModelCard, "id" | "name" | "mode" | "capabilities" | "originProvider">
> = [
	{
		id: "anthropic.claude-opus-4-6-v1:0",
		name: "Claude Opus 4.6 (Bedrock)",
		mode: "chat",
		capabilities: ["chat", "vision", "code", "nlu", "function_calling"],
		originProvider: "anthropic",
	},
	{
		id: "anthropic.claude-sonnet-4-6-v1:0",
		name: "Claude Sonnet 4.6 (Bedrock)",
		mode: "chat",
		capabilities: ["chat", "vision", "code", "nlu", "function_calling"],
		originProvider: "anthropic",
	},
	{
		id: "anthropic.claude-haiku-4-5-v1:0",
		name: "Claude Haiku 4.5 (Bedrock)",
		mode: "chat",
		capabilities: ["chat", "vision", "code", "nlu", "function_calling"],
		originProvider: "anthropic",
	},
	{
		id: "amazon.titan-text-premier-v2:0",
		name: "Titan Text Premier v2 (Bedrock)",
		mode: "chat",
		capabilities: ["chat", "nlu"],
		originProvider: "amazon",
	},
	{
		id: "amazon.titan-embed-text-v2:0",
		name: "Titan Embed Text v2 (Bedrock)",
		mode: "embedding",
		capabilities: ["embedding"],
		originProvider: "amazon",
	},
	{
		id: "meta.llama3-3-70b-instruct-v1:0",
		name: "Llama 3.3 70B Instruct (Bedrock)",
		mode: "chat",
		capabilities: ["chat", "code", "nlu"],
		originProvider: "meta",
	},
	{
		id: "mistral.mistral-large-2411-v1:0",
		name: "Mistral Large 2411 (Bedrock)",
		mode: "chat",
		capabilities: ["chat", "code", "nlu", "function_calling"],
		originProvider: "mistral",
	},
];

// ---------------------------------------------------------------------------
// BedrockDiscoverer
// ---------------------------------------------------------------------------

/**
 * Discovers models available through AWS Bedrock.
 *
 * Tries three resolution strategies in order:
 * 1. `@aws-sdk/client-bedrock` (if installed in the host project).
 * 2. AWS CLI (`aws bedrock list-foundation-models`).
 * 3. Static fallback catalogue.
 *
 * The `credential` argument is optional in the sense that the AWS SDK and CLI
 * both rely on the ambient credential chain.  However, the `credential.metadata`
 * bag may carry an explicit `{ region }` override.
 */
export class BedrockDiscoverer extends BaseDiscoverer {
	readonly providerId = "bedrock";
	readonly providerName = "AWS Bedrock";
	readonly baseUrl = "https://bedrock.us-east-1.amazonaws.com";

	/**
	 * Discover all foundation models available on AWS Bedrock.
	 *
	 * Resolution order: SDK → CLI → static fallback.
	 *
	 * @param credential - Optional credential; `metadata.region` overrides the
	 *                     `AWS_DEFAULT_REGION` environment variable.
	 * @param options    - Optional timeout in milliseconds (used for CLI exec).
	 */
	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		// 1. Try the AWS SDK first (zero-config, respects credential chain)
		try {
			const models = await this.discoverViaSdk(credential, options);
			if (models.length > 0) {
				return models;
			}
		} catch {
			// SDK not installed or threw — fall through to CLI
		}

		// 2. Fall back to the AWS CLI
		try {
			const models = await this.discoverViaCli(credential, options);
			if (models.length > 0) {
				return models;
			}
		} catch {
			// CLI not installed or threw — fall through to static list
		}

		// 3. Last resort: static catalogue
		return this.staticFallback();
	}

	// -------------------------------------------------------------------------
	// Strategy 1 — AWS SDK
	// -------------------------------------------------------------------------

	/**
	 * Use `@aws-sdk/client-bedrock` to list foundation models.
	 *
	 * Dynamic import prevents a hard dependency: the SDK is optional and must
	 * be installed separately by the host project.  If the import fails we
	 * throw so the caller can fall through to the next strategy.
	 *
	 * @throws When `@aws-sdk/client-bedrock` is not installed, or the API call fails.
	 */
	private async discoverViaSdk(credential: CredentialResult, _options?: { timeout?: number }): Promise<ModelCard[]> {
		// Dynamic import: will throw MODULE_NOT_FOUND if the SDK is absent.
		// The SDK is an optional peer dependency — not installed in kosha itself.
		// @ts-expect-error — optional peer dep, resolved at runtime by host project
		const { BedrockClient, ListFoundationModelsCommand } = await import("@aws-sdk/client-bedrock");

		const region = this.resolveRegion(credential);
		const client = new BedrockClient({ region });

		const response: BedrockListResponse = await client.send(new ListFoundationModelsCommand({}));
		const summaries = response.modelSummaries ?? [];

		return summaries.map((m) => this.toModelCard(m, "api", credential));
	}

	// -------------------------------------------------------------------------
	// Strategy 2 — AWS CLI
	// -------------------------------------------------------------------------

	/**
	 * Use the `aws` CLI to list foundation models.
	 *
	 * Runs `aws bedrock list-foundation-models --region {region} --output json`
	 * synchronously.  Wrapped in try/catch so failures are surfaced to the caller
	 * as thrown errors, letting `discover()` fall through gracefully.
	 *
	 * @throws When the `aws` CLI is not installed or returns a non-zero exit code.
	 */
	private async discoverViaCli(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const region = this.resolveRegion(credential);
		// Default CLI timeout: 15 s (slower than SDK due to subprocess overhead)
		const timeoutMs = options?.timeout ?? 15_000;

		let stdout: string;
		try {
			stdout = execSync(`aws bedrock list-foundation-models --region ${region} --output json`, {
				timeout: timeoutMs,
				encoding: "utf8",
				// Suppress stderr — credential errors print there, not on stdout
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch (error: unknown) {
			// Re-throw so discover() can fall through to the static list
			throw new Error(`AWS CLI failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		let parsed: BedrockCliResponse;
		try {
			parsed = JSON.parse(stdout) as BedrockCliResponse;
		} catch {
			throw new Error("AWS CLI returned invalid JSON");
		}

		return (parsed.modelSummaries ?? []).map((m) => this.toModelCard(m, "api", credential));
	}

	// -------------------------------------------------------------------------
	// Strategy 3 — Static fallback
	// -------------------------------------------------------------------------

	/**
	 * Return a hardcoded catalogue of well-known Bedrock foundation models.
	 *
	 * Used when neither the SDK nor the CLI is available.  All entries have
	 * `source: "manual"` and zero context/output token limits — the litellm
	 * enrichment pass is expected to populate those fields later.
	 */
	private staticFallback(): ModelCard[] {
		return STATIC_MODELS.map((entry) =>
			this.makeCard({
				id: entry.id,
				name: entry.name,
				provider: this.providerId,
				originProvider: entry.originProvider,
				mode: entry.mode,
				capabilities: [...entry.capabilities],
				contextWindow: 0,
				maxOutputTokens: 0,
				source: "manual",
			}),
		);
	}

	// -------------------------------------------------------------------------
	// Shared mapping helpers
	// -------------------------------------------------------------------------

	/**
	 * Convert a raw Bedrock foundation model summary into a {@link ModelCard}.
	 *
	 * @param model  - Raw model summary from SDK or CLI.
	 * @param source - Whether the data came from a live API call or static data.
	 * @param credential - Used to attach the resolved AWS region.
	 */
	private toModelCard(
		model: BedrockFoundationModel,
		source: "api" | "manual",
		credential: CredentialResult,
	): ModelCard {
		const mode = this.inferMode(model);
		const capabilities = this.inferCapabilities(model);
		const originProvider = inferOriginFromBedrockId(model.modelId);
		const region = this.resolveRegion(credential);

		return this.makeCard({
			id: model.modelId,
			name: model.modelName || model.modelId,
			provider: this.providerId,
			originProvider,
			mode,
			capabilities,
			contextWindow: 0,
			maxOutputTokens: 0,
			source,
			region,
		});
	}

	/**
	 * Infer the primary {@link ModelMode} from Bedrock output modalities.
	 *
	 * Bedrock reports modalities as uppercase strings: "TEXT", "IMAGE", "EMBEDDING".
	 * We pick the most specific non-TEXT modality first; TEXT-only → "chat".
	 */
	private inferMode(model: BedrockFoundationModel): ModelMode {
		const output = (model.outputModalities ?? []).map((m) => m.toUpperCase());
		const id = model.modelId.toLowerCase();

		// Embedding: explicit modality or keyword in ID
		if (output.includes("EMBEDDING") || id.includes("embed")) {
			return "embedding";
		}

		// Image generation: output includes IMAGE but not TEXT
		if (output.includes("IMAGE") && !output.includes("TEXT")) {
			return "image";
		}

		return "chat";
	}

	/**
	 * Infer capability flags from Bedrock input/output modalities and inference types.
	 *
	 * - "embedding" models → ["embedding"]
	 * - "image" output-only models → ["image"]
	 * - All chat models get ["chat"] plus optional vision/code/function_calling
	 */
	private inferCapabilities(model: BedrockFoundationModel): string[] {
		const input = (model.inputModalities ?? []).map((m) => m.toUpperCase());
		const output = (model.outputModalities ?? []).map((m) => m.toUpperCase());
		const id = model.modelId.toLowerCase();

		// Embedding models have a single capability
		if (output.includes("EMBEDDING") || id.includes("embed")) {
			return ["embedding"];
		}

		// Image-generation-only models
		if (output.includes("IMAGE") && !output.includes("TEXT")) {
			return ["image"];
		}

		const capabilities: string[] = ["chat"];

		// Vision: the model accepts IMAGE input
		if (input.includes("IMAGE")) {
			capabilities.push("vision");
		}

		// Claude models on Bedrock always support code, NLU, and function calling
		if (id.includes("claude")) {
			capabilities.push("code", "nlu", "function_calling");
		}

		// Mistral large variants support function calling
		if (id.includes("mistral") && id.includes("large")) {
			capabilities.push("function_calling");
		}

		// Streaming inference type is informational — not a capability flag
		return capabilities;
	}

	/**
	 * Resolve the AWS region to use for API calls.
	 *
	 * Priority: `credential.metadata.region` > `AWS_DEFAULT_REGION` env var > `"us-east-1"`.
	 */
	private resolveRegion(credential: CredentialResult): string {
		return credential.metadata?.region ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
	}
}

// ---------------------------------------------------------------------------
// Exported helper (also used in tests)
// ---------------------------------------------------------------------------

/**
 * Extract the origin provider from a Bedrock model ID.
 *
 * Bedrock model IDs follow the pattern `{vendor}.{model-name}-v{n}:{variant}`,
 * e.g. `anthropic.claude-opus-4-6-v1:0` → `"anthropic"`.
 *
 * Falls back to `"unknown"` for unrecognised vendor prefixes.
 *
 * @param modelId - A Bedrock foundation model ID.
 * @returns The canonical origin provider string.
 *
 * @example
 * inferOriginFromBedrockId("anthropic.claude-sonnet-4-6-v1:0") // "anthropic"
 * inferOriginFromBedrockId("meta.llama3-3-70b-instruct-v1:0")  // "meta"
 * inferOriginFromBedrockId("amazon.titan-text-premier-v2:0")   // "amazon"
 */
export function inferOriginFromBedrockId(modelId: string): string {
	// The vendor prefix is everything before the first dot
	const dotIndex = modelId.indexOf(".");
	if (dotIndex === -1) {
		return "unknown";
	}

	const vendor = modelId.slice(0, dotIndex).toLowerCase();
	return VENDOR_TO_ORIGIN[vendor] ?? "unknown";
}
