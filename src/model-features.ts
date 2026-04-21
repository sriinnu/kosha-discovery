/**
 * kosha-discovery — Tool-dialect and structured-output inference.
 *
 * Tool calling and structured output are two surfaces where every frontier
 * provider has settled on a *different* JSON shape. A consumer that wants
 * to route a single workload across multiple providers has to pick the
 * right adapter per model, and the registry is the natural place to tag
 * that. These helpers return best-effort hints inferred from the origin
 * provider plus the model ID — downstream callers treat them as defaults
 * and override with direct API probes when precision matters.
 * @module
 */

import type { StructuredOutputMode, ToolDialect } from "./types.js";

/**
 * Infer the tool-calling dialect a model natively speaks.
 *
 * The return value describes the wire format a consumer must emit to
 * invoke tools on this model. Returns `undefined` when the provider is
 * unknown and the model ID gives no signal — the caller should then
 * fall back to `"openai-tools"` (the de-facto compatibility dialect).
 *
 * Mapping summary:
 * - OpenAI GPT-4.1 / GPT-5 / o-series     → `"openai-responses"` (new API)
 * - OpenAI GPT-4 / GPT-4o / GPT-3.5       → `"openai-tools"`
 * - Anthropic Claude 3+                   → `"anthropic-tools"`
 * - Google Gemini 1.5+                    → `"gemini-functions"`
 * - Cohere Command R / R+                 → `"cohere-tools"`
 * - Mistral Large / Small                 → `"mistral-tools"`
 * - Meta Llama 3.1+ (instruct variants)   → `"llama3-tools"`
 * - Embedding / image / audio-only models → `"none"`
 *
 * NOTE on serving-layer proxies: this helper infers the model's *native*
 * dialect from its origin provider. Managed serving layers such as Groq,
 * Together, Fireworks, and OpenRouter expose open-weight models behind
 * an OpenAI-compatible tools API regardless of the underlying family —
 * so if you are calling a Llama 3.1 model through Groq, you should use
 * `"openai-tools"` on the wire, not the `"llama3-tools"` hint returned
 * here. Callers that care about the serving-layer wire format should
 * check `ModelCard.provider` (the serving slug) first and fall back to
 * this inference only for direct-origin routes. A future revision may
 * take `servingProvider` as a second argument.
 *
 * @param originProvider - Model creator slug (e.g. `"anthropic"`).
 * @param modelId        - Provider-canonical model ID.
 * @returns Best-effort dialect tag, or `undefined` when no safe guess exists.
 */
export function inferToolDialect(
	originProvider: string | undefined,
	modelId: string,
): ToolDialect | undefined {
	if (!modelId) return undefined;
	const id = modelId.toLowerCase();
	const origin = originProvider?.toLowerCase();

	// Embedding / image / audio / moderation / rerank families — no tool calling.
	if (
		/^(text-embedding|embed-|rerank-|voyage-|bge-|e5-)/.test(id) ||
		/^(dall-e|imagen|stable-diffusion|flux|midjourney)/.test(id) ||
		/^(whisper|tts-|parakeet|wavenet)/.test(id) ||
		/(^|-)moderation(-|$)/.test(id)
	) {
		return "none";
	}

	// OpenAI — newer frontier models (GPT-4.1, GPT-5, o1/o3/o4) target Responses API.
	if (origin === "openai" || /^(gpt-|o[134]|text-embedding-|chatgpt)/.test(id)) {
		if (/gpt-4\.1|gpt-5|^o1\b|^o3\b|^o4\b/.test(id) || id.startsWith("o1-") || id.startsWith("o3-") || id.startsWith("o4-")) {
			return "openai-responses";
		}
		// Legacy GPT-3.5 has very flaky tool calling; newer GPT-3.5-turbo 1106+ supports it.
		if (/gpt-3\.5-turbo-(0301|0613)|text-davinci|ada|babbage|curie/.test(id)) {
			return "none";
		}
		return "openai-tools";
	}

	// Anthropic Claude — Messages API tool_use is available from Claude 2.1+.
	if (origin === "anthropic" || /claude/.test(id)) {
		if (/claude-(instant|1|2\.0)/.test(id)) return "none";
		return "anthropic-tools";
	}

	// Google Gemini — function calling lives in Gemini 1.0+; Bison/PaLM are legacy.
	if (origin === "google" || origin === "vertex" || /gemini/.test(id)) {
		if (/bison|gecko|palm/.test(id)) return "none";
		return "gemini-functions";
	}

	// Cohere Command family supports tools; embed/rerank do not (handled above).
	if (origin === "cohere" || /^command-/.test(id)) {
		return "cohere-tools";
	}

	// Mistral — OpenAI-compatible tools with Mistral-specific quirks around parallel calls.
	if (origin === "mistral" || /mistral|mixtral|codestral|pixtral/.test(id)) {
		// Base / 7B / legacy models did not ship with tool calling.
		if (/mistral-(7b|tiny|small-2312)|mixtral-8x7b-v0\.1/.test(id)) return "none";
		return "mistral-tools";
	}

	// Meta Llama — tool calling formalized in Llama 3.1 instruct tune and
	// carried forward in Llama 4 (Scout / Maverick / Behemoth) with the same
	// JSON-in-prompt dialect, so both families share the "llama3-tools" tag.
	if (origin === "meta" || /llama/.test(id)) {
		if (/llama-?4/.test(id)) return "llama3-tools";
		if (/llama-?3\.?[123]|llama-?3-(8b|70b|405b)-instruct/.test(id)) {
			return "llama3-tools";
		}
		// Older Llama 2 / base Llama 3 lack first-class tool calling.
		return "none";
	}

	// DeepSeek / Qwen — both expose OpenAI-compatible tools in newer chat variants.
	if (origin === "deepseek" || /deepseek/.test(id)) {
		if (/deepseek-(v3|r1|chat|coder-v2)/.test(id)) return "openai-tools";
		return "none";
	}
	if (origin === "alibaba" || origin === "qwen" || /\bqwen/.test(id)) {
		if (/qwen-?[23]|qwen2\.5|qwen3/.test(id)) return "openai-tools";
		return "none";
	}

	return undefined;
}

/**
 * Infer the structured-output modes a model supports.
 *
 * Returns an ordered list with the most precise mode first. An empty
 * array means no structured-output enforcement is available and the
 * caller must fall back to prompt-level coercion.
 *
 * Precision ranking: `json-schema` > `response-schema` > `grammar`
 * > `json-mode` > `response-format` > `tool-choice` > `xml`.
 *
 * @param originProvider - Model creator slug.
 * @param modelId        - Provider-canonical model ID.
 * @returns Ordered list of supported modes (empty when unknown).
 */
export function inferStructuredOutputModes(
	originProvider: string | undefined,
	modelId: string,
): StructuredOutputMode[] {
	if (!modelId) return [];
	const id = modelId.toLowerCase();
	const origin = originProvider?.toLowerCase();

	// Embedding / image / audio / rerank / moderation — no structured output.
	if (
		/^(text-embedding|embed-|rerank-|voyage-|bge-|e5-)/.test(id) ||
		/^(dall-e|imagen|stable-diffusion|flux|midjourney)/.test(id) ||
		/^(whisper|tts-|parakeet|wavenet)/.test(id) ||
		/(^|-)moderation(-|$)/.test(id)
	) {
		return [];
	}

	// OpenAI — json_schema strict mode rolled out with GPT-4o-2024-08-06.
	// json_object (json-mode) is broadly available on GPT-4 turbo / GPT-4o / GPT-3.5-turbo-1106+.
	if (origin === "openai" || /^(gpt-|o[134]|chatgpt)/.test(id)) {
		const modes: StructuredOutputMode[] = [];
		if (/gpt-4o|gpt-4\.1|gpt-5|^o1\b|^o3\b|^o4\b|chatgpt-4o/.test(id) || id.startsWith("o1-") || id.startsWith("o3-") || id.startsWith("o4-")) {
			modes.push("json-schema", "json-mode");
		} else if (/gpt-4-turbo|gpt-4-1106|gpt-4-0125|gpt-3\.5-turbo-(1106|0125)/.test(id)) {
			modes.push("json-mode");
		}
		return modes;
	}

	// Anthropic — no native JSON-schema enforcement yet; tool-choice coercion + XML guidance.
	if (origin === "anthropic" || /claude/.test(id)) {
		if (/claude-(instant|1|2\.0)/.test(id)) return ["xml"];
		return ["tool-choice", "xml"];
	}

	// Google Gemini — response_schema is available on Gemini 1.5+ and all 2.x variants.
	if (origin === "google" || origin === "vertex" || /gemini/.test(id)) {
		if (/bison|gecko|palm|gemini-1\.0/.test(id)) return [];
		return ["response-schema"];
	}

	// Cohere — response_format with schema on Command R+ and newer.
	if (origin === "cohere" || /^command-/.test(id)) {
		return ["response-format"];
	}

	// Mistral — response_format json_object on Large/Medium; json_schema on Large 2411+.
	if (origin === "mistral" || /mistral|mixtral|codestral/.test(id)) {
		if (/mistral-large-(2411|2\d{3})|mistral-large-latest/.test(id)) {
			return ["json-schema", "json-mode"];
		}
		if (/mistral-(large|medium|small)/.test(id)) return ["json-mode"];
		return [];
	}

	// Local / llama.cpp-style runtimes — grammar is the universal hammer.
	if (origin === "ollama" || origin === "llama.cpp" || origin === "llamacpp") {
		return ["grammar", "json-mode"];
	}

	// Meta Llama 3.1+ instruct and Llama 4 — tool-choice coercion is the
	// honest fallback; no native JSON-schema enforcement on the model side.
	if (origin === "meta" || /llama/.test(id)) {
		if (/llama-?4/.test(id)) return ["tool-choice"];
		if (/llama-?3\.?[123]|llama-?3-(8b|70b|405b)-instruct/.test(id)) {
			return ["tool-choice"];
		}
		return [];
	}

	// DeepSeek / Qwen — OpenAI-compatible response_format on newer chat variants.
	if (origin === "deepseek" || /deepseek/.test(id)) {
		if (/deepseek-(v3|r1|chat|coder-v2)/.test(id)) return ["json-mode"];
		return [];
	}
	if (origin === "alibaba" || origin === "qwen" || /\bqwen/.test(id)) {
		if (/qwen-?[23]|qwen2\.5|qwen3/.test(id)) return ["json-mode"];
		return [];
	}

	return [];
}

/**
 * Best-effort inference for whether a model supports parallel tool calls
 * (multiple tool invocations emitted in a single assistant turn).
 *
 * Frontier models (GPT-4o, Claude 3.5+, Gemini 1.5+) all support this;
 * older tool-capable models (GPT-3.5, early Claude 3) emit tool calls
 * serially. Returns `undefined` when the model does not appear to support
 * tool calling at all.
 *
 * @param originProvider - Model creator slug.
 * @param modelId        - Provider-canonical model ID.
 * @returns `true`, `false`, or `undefined` when not tool-capable.
 */
export function inferParallelToolCalls(
	originProvider: string | undefined,
	modelId: string,
): boolean | undefined {
	const dialect = inferToolDialect(originProvider, modelId);
	if (!dialect || dialect === "none") return undefined;

	const id = modelId.toLowerCase();

	// OpenAI: parallel calls ship on every tool-capable OpenAI model
	// (gpt-3.5-turbo-1106+, gpt-4-turbo-preview+, gpt-4o, o-series).
	if (dialect === "openai-tools" || dialect === "openai-responses") {
		return true;
	}

	// Anthropic: parallel tool_use available from Claude 3.5+.
	if (dialect === "anthropic-tools") {
		if (/claude-3-(opus|sonnet|haiku)-(2024|20240)/.test(id)) return false;
		return true;
	}

	// Gemini: parallel functionCall parts supported from 1.5.
	if (dialect === "gemini-functions") {
		if (/gemini-1\.0/.test(id)) return false;
		return true;
	}

	// Cohere / Mistral / Llama3 / DeepSeek / Qwen — newer models support parallel.
	return true;
}
