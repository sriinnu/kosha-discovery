/**
 * kosha-discovery — NVIDIA provider discoverer.
 *
 * Queries the NVIDIA build.nvidia.com `/v1/models` endpoint (OpenAI-compatible),
 * filters relevant models, and maps them into {@link ModelCard} objects.
 *
 * NVIDIA's API catalog is multi-vendor, hosting models from nvidia, meta,
 * mistral, google, microsoft, deepseek, qwen, and others.
 * @module
 */

import type { ModelMode } from "../types.js";
import { OpenAICompatibleDiscoverer, type OpenAICompatibleModel, type ModelClassification } from "./openai-compatible.js";

/** Known origin provider prefixes in NVIDIA's model catalog. */
const KNOWN_ORIGIN_PREFIXES = [
	"nvidia",
	"meta",
	"mistralai",
	"mistral",
	"google",
	"microsoft",
	"deepseek",
	"qwen",
	"ibm",
	"snowflake",
	"databricks",
	"writer",
	"mediatek",
	"rakuten",
	"nv-mistralai",
] as const;

/**
 * Discovers models available through the NVIDIA API (build.nvidia.com).
 *
 * The NVIDIA catalog serves models from multiple vendors using an
 * OpenAI-compatible API. Model IDs are namespaced (e.g. `nvidia/llama-3.1-nemotron-70b-instruct`,
 * `meta/llama-3.1-405b-instruct`), allowing origin provider extraction from the prefix.
 */
export class NvidiaDiscoverer extends OpenAICompatibleDiscoverer {
	readonly providerId = "nvidia";
	readonly providerName = "NVIDIA";
	readonly baseUrl = "https://integrate.api.nvidia.com";

	/**
	 * Determine whether a model ID represents a model we want to track.
	 *
	 * We keep chat/instruct models and filter out:
	 * - Embedding-only models (handled separately if needed)
	 * - Reward models (used for RLHF, not inference)
	 * - Guard/safety models (used for content filtering pipelines)
	 */
	protected isRelevantModel(model: OpenAICompatibleModel): boolean {
		const lower = model.id.toLowerCase();

		// Skip reward models — used for RLHF, not direct inference
		if (lower.includes("reward")) return false;

		// Skip guard/safety filter models (but keep llama-guard)
		if (lower.includes("guard") && !lower.includes("llama-guard")) return false;

		return true;
	}

	/**
	 * Classify an NVIDIA model: extract origin provider, infer mode and capabilities.
	 */
	protected classifyModel(model: OpenAICompatibleModel): ModelClassification {
		const id = model.id;
		const lower = id.toLowerCase();
		const originProvider = this.extractOriginProvider(id);
		const mode = this.inferMode(lower);
		const capabilities = this.inferCapabilities(lower);

		return {
			originProvider,
			mode,
			capabilities,
		};
	}

	/**
	 * Extract the origin provider from a namespaced model ID.
	 *
	 * NVIDIA model IDs use `vendor/model-name` format. The prefix before
	 * the first `/` identifies the origin provider.
	 *
	 * @example
	 * extractOriginProvider("nvidia/llama-3.1-nemotron-70b-instruct") // "nvidia"
	 * extractOriginProvider("meta/llama-3.1-405b-instruct")           // "meta"
	 */
	private extractOriginProvider(id: string): string {
		const slashIdx = id.indexOf("/");
		if (slashIdx === -1) return "nvidia";

		const prefix = id.slice(0, slashIdx).toLowerCase();

		// Normalize known prefixes
		if (prefix === "mistralai" || prefix === "nv-mistralai") return "mistral";

		for (const known of KNOWN_ORIGIN_PREFIXES) {
			if (prefix === known) return known;
		}

		return prefix;
	}

	/** Map a model ID to its primary {@link ModelMode}. */
	private inferMode(id: string): ModelMode {
		if (id.includes("embed")) return "embedding";
		if (id.includes("rerank")) return "embedding";
		return "chat";
	}

	/**
	 * Infer capability flags from the model ID.
	 *
	 * Key heuristics:
	 * - Embedding models get "embedding" only
	 * - Models with "vlm", "vision", or known vision model names get "vision"
	 * - Instruct/chat models get "function_calling" (NVIDIA API supports it)
	 * - Code-specialized models get "code"
	 */
	private inferCapabilities(id: string): string[] {
		// Embedding models
		if (id.includes("embed") || id.includes("rerank")) {
			return ["embedding"];
		}

		const caps: string[] = ["chat"];

		// Vision models
		if (
			id.includes("vlm") ||
			id.includes("vision") ||
			id.includes("llava") ||
			id.includes("cogvlm") ||
			id.includes("fuyu") ||
			id.includes("neva") ||
			id.includes("vila")
		) {
			caps.push("vision");
		}

		// Code-specialized models
		if (
			id.includes("code") ||
			id.includes("codestral") ||
			id.includes("starcoder") ||
			id.includes("codellama")
		) {
			caps.push("code");
		}

		// Function calling — most instruct models on NVIDIA support it
		if (id.includes("instruct") || id.includes("chat") || id.includes("nemotron")) {
			caps.push("function_calling");
		}

		return caps;
	}
}
