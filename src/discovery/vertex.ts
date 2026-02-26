/**
 * kosha-discovery — Google Vertex AI provider discoverer.
 *
 * Resolution strategy (in order):
 * 1. REST API with Application Default Credentials (ADC)
 * 2. gcloud CLI fallback (`gcloud ai models list`)
 * 3. Static fallback list of known Vertex AI models
 *
 * Credentials: Uses the Google ADC chain —
 *   ~/.config/gcloud/application_default_credentials.json,
 *   GOOGLE_APPLICATION_CREDENTIALS env var, or the GCP metadata server.
 * @module
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialResult, ModelCard, ModelMode } from "../types.js";
import { BaseDiscoverer } from "./base.js";

// ---------------------------------------------------------------------------
// API / ADC response shapes
// ---------------------------------------------------------------------------

/** A single model entry from the Vertex AI Publisher Models API. */
interface VertexModel {
	/** Full resource name, e.g. "publishers/google/models/gemini-2.5-pro". */
	name: string;
	/** Optional human-readable display name. */
	displayName?: string;
	/** Supported actions / generation methods (e.g. "generateContent", "embedContent"). */
	supportedActions?: string[];
}

/** Top-level response from the Vertex AI list-models endpoint. */
interface VertexListResponse {
	publisherModels?: VertexModel[];
	/** Alternative key used on some regional endpoints. */
	models?: VertexModel[];
	nextPageToken?: string;
}

/** Parsed fields from an Application Default Credentials JSON file. */
interface AdcCredentials {
	client_id?: string;
	client_secret?: string;
	refresh_token?: string;
	access_token?: string;
}

/** Successful response from the Google OAuth2 token exchange endpoint. */
interface OAuthTokenResponse {
	access_token: string;
	expires_in: number;
	token_type: string;
}

/** A single entry produced by `gcloud ai models list --format=json`. */
interface GcloudModel {
	name: string;
	displayName?: string;
}

// ---------------------------------------------------------------------------
// VertexDiscoverer
// ---------------------------------------------------------------------------

/**
 * Discovers models available through Google Vertex AI.
 *
 * Works without an explicit API key: access tokens are resolved via the
 * standard ADC chain, so it behaves correctly in local dev environments
 * (after `gcloud auth application-default login`) and on GCP VMs (metadata
 * server).  When the REST API is unavailable it falls back to the gcloud CLI,
 * and when that is missing it returns a curated static list so callers always
 * receive useful results.
 */
export class VertexDiscoverer extends BaseDiscoverer {
	readonly providerId = "vertex";
	readonly providerName = "Google Vertex AI";
	/** Template string — region is substituted per-request. */
	readonly baseUrl = "https://{region}-aiplatform.googleapis.com";

	/**
	 * Discover models from Vertex AI using a three-tier fallback strategy:
	 *   1. Vertex AI REST API (requires an ADC access token + project ID)
	 *   2. `gcloud ai models list` CLI
	 *   3. Curated static list
	 *
	 * @param credential - Credential bag; `accessToken` is used when present.
	 *   `metadata.projectId` and `metadata.region` take precedence over env vars.
	 * @param options    - Optional timeout in ms (default 10 000).
	 */
	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		// Project ID resolution: credential → env vars → gcloud config
		let projectId =
			credential.metadata?.projectId ??
			process.env.GOOGLE_CLOUD_PROJECT ??
			process.env.GCLOUD_PROJECT;

		if (!projectId) {
			projectId = this.resolveProjectFromCli();
		}

		// Region resolution: credential → env var → default
		const region = credential.metadata?.region ?? process.env.GOOGLE_CLOUD_REGION ?? "us-central1";

		// Attempt 1: REST API
		try {
			const cards = await this.discoverViaApi(credential, projectId, region, options);
			if (cards.length > 0) return cards;
		} catch {
			// Fall through to CLI
		}

		// Attempt 2: gcloud CLI
		if (projectId) {
			try {
				const cards = await this.discoverViaCli(projectId, region);
				if (cards.length > 0) return cards;
			} catch {
				// Fall through to static list
			}
		}

		// Attempt 3: Static fallback
		return this.staticFallback(region, projectId);
	}

	// -------------------------------------------------------------------------
	// Private: REST API
	// -------------------------------------------------------------------------

	/**
	 * Fetch models from the Vertex AI Publisher Models REST endpoint.
	 *
	 * URL: `https://{region}-aiplatform.googleapis.com/v1/projects/{project}/
	 *       locations/{region}/publishers/google/models`
	 *
	 * @param credential - Used to obtain a Bearer token via {@link getAccessToken}.
	 * @param projectId  - GCP project ID (required for the REST path).
	 * @param region     - GCP region (e.g. "us-central1").
	 * @param options    - Optional timeout override.
	 */
	private async discoverViaApi(
		credential: CredentialResult,
		projectId: string | undefined,
		region: string,
		options?: { timeout?: number },
	): Promise<ModelCard[]> {
		if (!projectId) throw new Error("Vertex AI: project ID is required for the REST API");

		const token = await this.getAccessToken(credential);
		if (!token) throw new Error("Vertex AI: could not obtain an access token");

		const host = `https://${region}-aiplatform.googleapis.com`;
		const url = `${host}/v1/projects/${projectId}/locations/${region}/publishers/google/models`;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		};

		const response = await this.fetchJSON<VertexListResponse>(url, headers, options?.timeout ?? 10_000);
		const rawModels: VertexModel[] = response.publisherModels ?? response.models ?? [];
		return rawModels.map((m) => this.toModelCard(m, region, projectId));
	}

	// -------------------------------------------------------------------------
	// Private: ADC token resolution
	// -------------------------------------------------------------------------

	/**
	 * Resolve a Google OAuth2 access token using the ADC chain:
	 *   1. `credential.accessToken` — already resolved upstream
	 *   2. ADC JSON file containing `access_token` (service account / workload identity)
	 *   3. ADC JSON file with `refresh_token` — exchange via Google OAuth endpoint
	 *   4. `gcloud auth print-access-token` CLI fallback
	 *
	 * Returns `undefined` when no token can be obtained.
	 *
	 * @param credential - The credential bag from the discovery pipeline.
	 */
	async getAccessToken(credential: CredentialResult): Promise<string | undefined> {
		// 1. Token already present in credential
		if (credential.accessToken) return credential.accessToken;

		// 2 & 3. Try the ADC credentials file
		const adcPath =
			process.env.GOOGLE_APPLICATION_CREDENTIALS ??
			join(homedir(), ".config", "gcloud", "application_default_credentials.json");

		try {
			const adc = JSON.parse(readFileSync(adcPath, "utf8")) as AdcCredentials;

			// 2a. Pre-issued access token (rare, but valid for some service accounts)
			if (adc.access_token) return adc.access_token;

			// 2b. Refresh-token flow (typical after `gcloud auth application-default login`)
			if (adc.refresh_token && adc.client_id && adc.client_secret) {
				return await this.exchangeRefreshToken(adc.client_id, adc.client_secret, adc.refresh_token);
			}
		} catch {
			// ADC file absent or unreadable — continue to CLI fallback
		}

		// 4. gcloud CLI fallback
		return this.tokenFromGcloudCli();
	}

	/**
	 * Exchange a refresh token for a short-lived access token via Google OAuth2.
	 *
	 * @param clientId     - OAuth2 client ID from the ADC file.
	 * @param clientSecret - OAuth2 client secret from the ADC file.
	 * @param refreshToken - Refresh token from the ADC file.
	 */
	private async exchangeRefreshToken(
		clientId: string,
		clientSecret: string,
		refreshToken: string,
	): Promise<string | undefined> {
		const body = new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		});

		try {
			const res = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			});
			if (!res.ok) return undefined;
			const data = (await res.json()) as OAuthTokenResponse;
			return data.access_token;
		} catch {
			return undefined;
		}
	}

	/**
	 * Obtain an access token by calling `gcloud auth print-access-token`.
	 * Returns `undefined` when the CLI is not installed or the command fails.
	 */
	private tokenFromGcloudCli(): string | undefined {
		try {
			const out = execSync("gcloud auth print-access-token", {
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 8_000,
			})
				.toString()
				.trim();
			return out.length > 0 ? out : undefined;
		} catch {
			return undefined;
		}
	}

	// -------------------------------------------------------------------------
	// Private: gcloud CLI model discovery
	// -------------------------------------------------------------------------

	/**
	 * Discover models by executing `gcloud ai models list` and parsing JSON output.
	 *
	 * @param projectId - GCP project ID passed as `--project`.
	 * @param region    - GCP region passed as `--region`.
	 */
	private async discoverViaCli(projectId: string, region: string): Promise<ModelCard[]> {
		try {
			const raw = execSync(
				`gcloud ai models list --project=${projectId} --region=${region} --format=json`,
				{ stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 },
			).toString();

			const models = JSON.parse(raw) as GcloudModel[];
			if (!Array.isArray(models)) return [];
			return models.map((m) => this.gcloudModelToCard(m, region, projectId));
		} catch {
			return [];
		}
	}

	/**
	 * Resolve a GCP project ID from the active `gcloud` configuration.
	 * Returns `undefined` when the CLI is unavailable or unconfigured.
	 */
	private resolveProjectFromCli(): string | undefined {
		try {
			const out = execSync("gcloud config get-value project", {
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 5_000,
			})
				.toString()
				.trim();
			// gcloud prints "(unset)" when no project is configured
			return out && out !== "(unset)" ? out : undefined;
		} catch {
			return undefined;
		}
	}

	// -------------------------------------------------------------------------
	// Private: static fallback
	// -------------------------------------------------------------------------

	/**
	 * Return a curated list of well-known Vertex AI models (Feb 2026).
	 *
	 * Used when neither the REST API nor the gcloud CLI is accessible.
	 * All entries carry `source: "manual"` so consumers can distinguish them
	 * from live API data.
	 *
	 * @param region    - Propagated to each card's `region` field.
	 * @param projectId - Propagated to each card's `projectId` field (may be undefined).
	 */
	private staticFallback(region: string, projectId: string | undefined): ModelCard[] {
		const base = { provider: "vertex", originProvider: "google", region, projectId, source: "manual" as const };
		const geminiChat = (id: string, name: string, ctx: number, out: number): ModelCard =>
			this.makeCard({ ...base, id, name, mode: "chat", capabilities: ["chat", "vision", "function_calling", "code", "nlu"], contextWindow: ctx, maxOutputTokens: out });

		return [
			geminiChat("gemini-2.5-pro-preview-05-06", "Gemini 2.5 Pro Preview", 1_048_576, 65_536),
			geminiChat("gemini-2.5-flash-preview-04-17", "Gemini 2.5 Flash Preview", 1_048_576, 8_192),
			geminiChat("gemini-2.0-flash", "Gemini 2.0 Flash", 1_048_576, 8_192),
			this.makeCard({ ...base, id: "text-embedding-005", name: "Text Embedding 005", mode: "embedding", capabilities: ["embedding"], contextWindow: 2_048, maxOutputTokens: 0 }),
			this.makeCard({ ...base, id: "imagen-3.0-generate-002", name: "Imagen 3.0", mode: "image", capabilities: ["image_generation"], contextWindow: 0, maxOutputTokens: 0 }),
		];
	}

	// -------------------------------------------------------------------------
	// Private: model → ModelCard converters
	// -------------------------------------------------------------------------

	/**
	 * Convert a Vertex AI REST API model object to a {@link ModelCard}.
	 *
	 * The `name` field is a full resource path such as
	 * `publishers/google/models/gemini-2.5-pro`; the prefix is stripped to
	 * obtain the bare model ID used in API calls.
	 *
	 * @param model     - Raw Vertex API model entry.
	 * @param region    - Region the model was fetched from.
	 * @param projectId - GCP project ID.
	 */
	private toModelCard(model: VertexModel, region: string, projectId: string): ModelCard {
		const id = model.name.replace(/^.*\/models\//, "");
		const actions = model.supportedActions ?? [];
		return this.makeCard({
			id,
			name: model.displayName ?? id,
			provider: "vertex",
			originProvider: "google",
			mode: this.inferMode(id, actions),
			capabilities: this.inferCapabilities(id, actions),
			contextWindow: 0,
			maxOutputTokens: 0,
			region,
			projectId,
			source: "api",
		});
	}

	/**
	 * Convert a `gcloud ai models list` JSON entry to a {@link ModelCard}.
	 *
	 * gcloud returns full resource names such as
	 * `projects/{p}/locations/{r}/models/{id}` — we take only the last segment.
	 *
	 * @param model     - Raw gcloud JSON model entry.
	 * @param region    - Region used for the gcloud query.
	 * @param projectId - GCP project ID.
	 */
	private gcloudModelToCard(model: GcloudModel, region: string, projectId: string): ModelCard {
		const id = model.name.split("/").pop() ?? model.name;
		return this.makeCard({
			id,
			name: model.displayName ?? id,
			provider: "vertex",
			originProvider: "google",
			mode: this.inferMode(id, []),
			capabilities: this.inferCapabilities(id, []),
			contextWindow: 0,
			maxOutputTokens: 0,
			region,
			projectId,
			source: "manual",
		});
	}

	// -------------------------------------------------------------------------
	// Private: capability / mode inference
	// -------------------------------------------------------------------------

	/**
	 * Determine the primary {@link ModelMode} from a model ID and its
	 * supported actions list.
	 *
	 * @param id      - Bare model ID.
	 * @param actions - `supportedActions` array from the API response.
	 */
	private inferMode(id: string, actions: string[]): ModelMode {
		const lower = id.toLowerCase();
		if (actions.includes("embedContent") || lower.includes("embedding") || lower.includes("embed")) return "embedding";
		if (lower.includes("imagen") || lower.includes("image")) return "image";
		return "chat";
	}

	/**
	 * Infer capability flags from a model ID and its supported actions.
	 *
	 * Gemini pro/flash/ultra variants receive vision + function_calling because
	 * all modern Gemini editions support multimodal input and tool use.
	 *
	 * @param id      - Bare model ID.
	 * @param actions - `supportedActions` from the API response.
	 */
	private inferCapabilities(id: string, actions: string[]): string[] {
		const lower = id.toLowerCase();

		if (actions.includes("embedContent") || lower.includes("embedding") || lower.includes("embed")) return ["embedding"];
		if (lower.includes("imagen") || lower.includes("image")) return ["image_generation"];

		if (lower.includes("gemini")) {
			const caps = ["chat", "code", "nlu"];
			if (lower.includes("pro") || lower.includes("flash") || lower.includes("ultra")) {
				caps.push("vision", "function_calling");
			}
			return caps;
		}

		return ["chat"];
	}
}
