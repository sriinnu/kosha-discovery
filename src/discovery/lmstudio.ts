/**
 * kosha-discovery — LM Studio (local) discoverer.
 *
 * LM Studio runs an OpenAI-compatible HTTP server on `localhost:1234`. We
 * query `/v1/models` for the catalogue of locally-loaded models. Like the
 * other local discoverers, we return [] when the daemon is absent so a
 * full discovery pass keeps going.
 * @module
 */

import type { CredentialResult, LocalRuntimeMetadata, ModelCard, ModelMode } from "../types.js";
import { BaseDiscoverer } from "./base.js";

interface LmStudioModel {
	id: string;
	object: string;
	owned_by?: string;
}

interface LmStudioListResponse {
	data: LmStudioModel[];
	object: string;
}

export class LmStudioDiscoverer extends BaseDiscoverer {
	readonly providerId = "lmstudio";
	readonly providerName = "LM Studio (Local)";
	readonly baseUrl: string;

	constructor(baseUrl?: string) {
		super();
		this.baseUrl = baseUrl ?? "http://127.0.0.1:1234";
	}

	async discover(_credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const timeoutMs = this.validateTimeout(options?.timeout, 5_000);
		let response: LmStudioListResponse;
		try {
			response = await this.fetchJSON<LmStudioListResponse>(`${this.baseUrl}/v1/models`, undefined, timeoutMs);
		} catch (error: unknown) {
			if (this.isConnectionError(error)) return [];
			throw error;
		}
		if (!Array.isArray(response?.data)) return [];
		return response.data.map((model) => this.toModelCard(model));
	}

	private toModelCard(model: LmStudioModel): ModelCard {
		const id = this.normalizeLocalModelId(model.id);
		const mode = this.inferMode(id);
		const capabilities = this.inferRawCapabilities(id, mode);
		const localRuntime: LocalRuntimeMetadata = {
			runtimeFamily: "lmstudio",
			transport: "openai-compatible-http",
			supportsStreaming: true,
		};
		return this.makeCard({
			id,
			name: id,
			provider: this.providerId,
			mode,
			capabilities,
			rawCapabilities: capabilities,
			contextWindow: 0,
			maxOutputTokens: 0,
			source: "local",
			localRuntime,
		});
	}

	private normalizeLocalModelId(modelId: string): string {
		if (!modelId) return modelId;
		const segments = modelId.split(/[\\/]/).filter(Boolean);
		return segments[segments.length - 1] ?? modelId;
	}

	private inferMode(modelId: string): ModelMode {
		const lower = modelId.toLowerCase();
		if (lower.includes("rerank")) return "rerank";
		if (lower.includes("embed")) return "embedding";
		return "chat";
	}

	private inferRawCapabilities(modelId: string, mode: ModelMode): string[] {
		const lower = modelId.toLowerCase();
		if (mode === "embedding") return ["embedding"];
		if (mode === "rerank") return ["rerank"];
		const capabilities = ["chat"];
		if (lower.includes("code") || lower.includes("coder")) capabilities.push("code");
		if (lower.includes("vision") || lower.includes("vlm") || lower.includes("llava")) capabilities.push("vision");
		return capabilities;
	}

	private isConnectionError(error: unknown): boolean {
		const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
		return (
			message.includes("econnrefused") ||
			message.includes("enotfound") ||
			message.includes("econnreset") ||
			message.includes("fetch failed") ||
			message.includes("network") ||
			message.includes("aborted")
		);
	}
}
