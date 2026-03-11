/**
 * kosha-discovery — llama.cpp (local) discoverer.
 *
 * I target `llama-server`'s OpenAI-compatible `/v1/models` endpoint so
 * Chitragupta can treat llama.cpp as a first-class local runtime without
 * inventing a second local discovery protocol.
 * @module
 */

import type { CredentialResult, ComputeTarget, LocalRuntimeMetadata, ModelCard, ModelMode } from "../types.js";
import { BaseDiscoverer } from "./base.js";

/** Best-effort metadata bag returned by some llama.cpp server builds. */
interface LlamaCppModelMetadata {
	tokenizer_family?: string;
	quantization?: string;
	memory_footprint_bytes?: number;
	compute_target?: string;
	supports_structured_output?: boolean;
	supports_streaming?: boolean;
}

/** Shape of a single OpenAI-compatible model entry. */
interface LlamaCppModel {
	id: string;
	object: string;
	created?: number;
	owned_by?: string;
	context_window?: number;
	metadata?: LlamaCppModelMetadata;
}

/** Standard `/v1/models` response shape. */
interface LlamaCppListResponse {
	data: LlamaCppModel[];
	object: string;
}

/**
 * Discover locally served models from a llama.cpp `llama-server` process.
 *
 * The server is local and unauthenticated, so discovery returns an empty list
 * instead of throwing when the daemon is absent.
 */
export class LlamaCppDiscoverer extends BaseDiscoverer {
	readonly providerId = "llama.cpp";
	readonly providerName = "llama.cpp (Local)";
	readonly baseUrl: string;

	/**
	 * @param baseUrl - Override the default llama.cpp server URL.
	 */
	constructor(baseUrl?: string) {
		super();
		this.baseUrl = baseUrl ?? "http://127.0.0.1:8080";
	}

	/**
	 * Query the local OpenAI-compatible `/v1/models` endpoint.
	 */
	async discover(_credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const timeoutMs = this.validateTimeout(options?.timeout, 5_000);

		let response: LlamaCppListResponse;
		try {
			response = await this.fetchJSON<LlamaCppListResponse>(`${this.baseUrl}/v1/models`, undefined, timeoutMs);
		} catch (error: unknown) {
			if (this.isConnectionError(error)) {
				return [];
			}
			throw error;
		}

		if (!response.data || !Array.isArray(response.data)) {
			return [];
		}

		return response.data.map((model) => this.toModelCard(model));
	}

	/** Convert an OpenAI-compatible model payload into a normalized card. */
	private toModelCard(model: LlamaCppModel): ModelCard {
		const normalizedId = this.normalizeLocalModelId(model.id);
		const mode = this.inferMode(normalizedId);
		const rawCapabilities = this.inferRawCapabilities(normalizedId, mode);
		const localRuntime = this.buildRuntimeMetadata(model);

		return this.makeCard({
			id: normalizedId,
			name: normalizedId,
			provider: this.providerId,
			mode,
			capabilities: rawCapabilities,
			rawCapabilities,
			contextWindow: model.context_window ?? 0,
			maxOutputTokens: 0,
			source: "local",
			localRuntime,
		});
	}

	/** Strip path-like prefixes so local file-system details do not leak into IDs. */
	private normalizeLocalModelId(modelId: string): string {
		if (!modelId) return modelId;
		const segments = modelId.split(/[\\/]/).filter(Boolean);
		return segments[segments.length - 1] ?? modelId;
	}

	/** Infer the model mode from the normalized model ID. */
	private inferMode(modelId: string): ModelMode {
		const lower = modelId.toLowerCase();
		if (lower.includes("rerank")) return "rerank";
		if (lower.includes("embed")) return "embedding";
		return "chat";
	}

	/** Infer the free-form raw capability list for compatibility surfaces. */
	private inferRawCapabilities(modelId: string, mode: ModelMode): string[] {
		const lower = modelId.toLowerCase();
		if (mode === "embedding") {
			return ["embedding"];
		}
		if (mode === "rerank") {
			return ["rerank"];
		}

		const capabilities = ["chat"];
		if (lower.includes("code") || lower.includes("coder") || lower.includes("codellama")) {
			capabilities.push("code");
		}
		if (lower.includes("vision") || lower.includes("vlm") || lower.includes("llava")) {
			capabilities.push("vision");
		}
		return capabilities;
	}

	/** Build best-effort local runtime metadata from model payload fields. */
	private buildRuntimeMetadata(model: LlamaCppModel): LocalRuntimeMetadata {
		return {
			runtimeFamily: "llama.cpp",
			transport: "openai-compatible-http",
			tokenizerFamily: model.metadata?.tokenizer_family,
			quantization: model.metadata?.quantization,
			memoryFootprintBytes: model.metadata?.memory_footprint_bytes,
			computeTarget: this.normalizeComputeTarget(model.metadata?.compute_target),
			// llama.cpp grammars/JSON schema support make structured output a first-class capability.
			supportsStructuredOutput: model.metadata?.supports_structured_output ?? true,
			supportsStreaming: model.metadata?.supports_streaming ?? true,
		};
	}

	private normalizeComputeTarget(value: string | undefined): ComputeTarget | undefined {
		if (!value) return undefined;
		const normalized = value.toLowerCase();
		if (normalized.includes("gpu")) return "gpu";
		if (normalized.includes("cpu")) return "cpu";
		if (normalized.includes("hybrid")) return "hybrid";
		return "unknown";
	}

	/** Check whether the error represents an unavailable local server. */
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
