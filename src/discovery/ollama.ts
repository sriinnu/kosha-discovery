/**
 * kosha-discovery — Ollama (local) provider discoverer.
 *
 * Queries the Ollama REST API (`/api/tags`) on localhost to list locally
 * pulled models.  Because Ollama runs without authentication and may not
 * be installed at all, this discoverer fails gracefully on connection errors.
 * @module
 */

import type { CredentialResult, ModelCard } from "../types.js";
import { BaseDiscoverer } from "./base.js";

/** Detail metadata returned per model by Ollama. */
interface OllamaModelDetails {
	families: string[] | null;
	parameter_size: string;
	quantization_level: string;
}

/** Shape of a single pulled model from `/api/tags`. */
interface OllamaModel {
	name: string;
	model: string;
	modified_at: string;
	size: number;
	digest: string;
	details: OllamaModelDetails;
}

/** Response shape from `GET /api/tags`. */
interface OllamaTagsResponse {
	models: OllamaModel[];
}

/** Shape of a model currently loaded in memory from `/api/ps`. */
interface OllamaRunningModel {
	name: string;
	model: string;
	size: number;
	digest: string;
	expires_at: string;
}

/** Response shape from `GET /api/ps`. */
interface OllamaPsResponse {
	models: OllamaRunningModel[];
}

/**
 * Discovers locally-pulled models from an Ollama instance.
 *
 * Ollama requires no authentication, so the credential is ignored.
 * If the Ollama daemon is not running, discovery returns an empty array
 * instead of throwing, making it safe to include in every scan.
 */
export class OllamaDiscoverer extends BaseDiscoverer {
	readonly providerId = "ollama";
	readonly providerName = "Ollama (Local)";
	readonly baseUrl: string;

	/** Set of model names currently loaded in VRAM (warm). */
	private runningModels = new Set<string>();

	/**
	 * @param baseUrl - Override the default Ollama URL (default: `http://localhost:11434`).
	 *                  Useful when Ollama is running on a non-standard port or remote host.
	 */
	constructor(baseUrl?: string) {
		super();
		this.baseUrl = baseUrl ?? "http://localhost:11434";
	}

	/**
	 * List all locally-pulled models from Ollama.
	 *
	 * The `_credential` parameter is ignored — Ollama never requires auth.
	 * Uses a shorter default timeout (5 s) since the server is local.
	 */
	async discover(_credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const timeoutMs = options?.timeout ?? 5_000;

		// Best-effort fetch of currently loaded (warm) models — non-critical
		await this.fetchRunningModels(timeoutMs);

		let response: OllamaTagsResponse;
		try {
			response = await this.fetchJSON<OllamaTagsResponse>(`${this.baseUrl}/api/tags`, undefined, timeoutMs);
		} catch (error: unknown) {
			// Gracefully return empty when Ollama is not installed or not running,
			// rather than propagating connection errors up to the registry
			if (this.isConnectionError(error)) {
				return [];
			}
			throw error;
		}

		if (!response.models || !Array.isArray(response.models)) {
			return [];
		}

		return response.models.map((model) => this.toModelCard(model));
	}

	/**
	 * Fetch the list of models currently loaded in VRAM.
	 * Failures are silently ignored since this is purely informational.
	 */
	private async fetchRunningModels(timeoutMs: number): Promise<void> {
		try {
			const response = await this.fetchJSON<OllamaPsResponse>(`${this.baseUrl}/api/ps`, undefined, timeoutMs);
			if (response.models && Array.isArray(response.models)) {
				for (const model of response.models) {
					this.runningModels.add(model.name);
				}
			}
		} catch {
			// Non-critical — running model info is nice-to-have only
		}
	}

	/** Convert an Ollama model into a normalized {@link ModelCard}. */
	private toModelCard(model: OllamaModel): ModelCard {
		const capabilities = this.inferCapabilities(model);
		const mode = this.isEmbeddingModel(model.name) ? "embedding" as const : "chat" as const;

		return this.makeCard({
			id: model.name,
			name: model.name,
			provider: this.providerId,
			mode,
			capabilities,
			// Ollama's /api/tags does not return context window info;
			// the litellm enricher will fill these in later
			contextWindow: 0,
			maxOutputTokens: 0,
			source: "local",
		});
	}

	/**
	 * Infer capabilities from the model name and Ollama-provided family metadata.
	 */
	private inferCapabilities(model: OllamaModel): string[] {
		const name = model.name.toLowerCase();
		const families = model.details?.families ?? [];

		// Embedding models — detected by common naming patterns:
		// "nomic-embed-text", "mxbai-embed-large", "all-minilm", etc.
		if (this.isEmbeddingModel(name)) {
			return ["embedding"];
		}

		const capabilities: string[] = ["chat"];

		// Code-focused models (codestral, deepseek-coder, starcoder, codellama)
		if (name.includes("code") || name.includes("coder") || name.includes("starcoder") || name.includes("codellama")) {
			capabilities.push("code");
		} else {
			// Most general-purpose local models (llama, qwen, mistral) handle code too
			capabilities.push("code");
		}

		// Vision support: Ollama reports model families (e.g. "clip") in metadata;
		// also detect by well-known multimodal model names
		if (families.includes("clip") || name.includes("llava") || name.includes("vision")) {
			capabilities.push("vision");
		}

		return capabilities;
	}

	/**
	 * Detect embedding models by common naming conventions.
	 * Patterns: "embed", "nomic-embed", "mxbai-embed".
	 */
	private isEmbeddingModel(name: string): boolean {
		const lower = name.toLowerCase();
		return lower.includes("embed") || lower.includes("nomic-embed") || lower.includes("mxbai-embed");
	}

	/** Check whether an error represents a network connectivity failure. */
	private isConnectionError(error: unknown): boolean {
		const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
		return (
			message.includes("econnrefused") ||
			message.includes("enotfound") ||
			message.includes("econnreset") ||
			message.includes("fetch failed") ||
			message.includes("network") ||
			message.includes("timed out")
		);
	}
}
