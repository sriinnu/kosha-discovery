/**
 * kosha-discovery — Tokenizer-family inference for API-served models.
 *
 * Local runtimes (Ollama, llama.cpp) expose the tokenizer family via
 * {@link LocalRuntimeMetadata.tokenizerFamily}. For API-served models the
 * provider rarely publishes it explicitly, so we derive it from the
 * origin provider plus the model ID. The result is a best-effort hint
 * intended for tokenizer-aware downstream consumers (compression
 * libraries, routing policies, cost estimators) — not a guarantee.
 * @module
 */

/**
 * Infer a best-effort tokenizer-family identifier for a model.
 *
 * Returns a normalized string when the mapping is confident, or
 * `undefined` when no safe inference is available. Consumers must
 * treat the return value as a hint and fall back to their own
 * defaults when it is absent.
 *
 * Known families returned:
 * - `"o200k_base"` — OpenAI GPT-4o, GPT-4.1, o1/o3/o4 families
 * - `"cl100k_base"` — OpenAI GPT-4, GPT-3.5-turbo, text-embedding-3
 * - `"claude"` — Anthropic Claude family (proprietary tokenizer)
 * - `"gemini"` — Google Gemini family (proprietary tokenizer)
 * - `"llama4"` — Meta Llama 4 family (~200k vocab BPE)
 * - `"llama3"` — Meta Llama 3.x family (128k vocab BPE)
 * - `"llama2"` — Meta Llama 2 / CodeLlama (32k vocab)
 * - `"mistral"` — Mistral/Mixtral family
 * - `"cohere"` — Cohere Command/Embed family
 * - `"deepseek"` — DeepSeek family
 * - `"qwen"` — Alibaba Qwen family
 *
 * @param originProvider - The model's creator (not the serving layer).
 *                         Examples: `"anthropic"`, `"openai"`, `"meta"`.
 * @param modelId        - Provider-canonical model ID.
 * @returns Tokenizer-family hint, or `undefined`.
 */
export function inferTokenizerFamily(
	originProvider: string | undefined,
	modelId: string,
): string | undefined {
	if (!modelId) return undefined;
	const id = modelId.toLowerCase();
	const origin = originProvider?.toLowerCase();

	// OpenAI — GPT-4o / GPT-4.1 / o1–o4 use o200k_base; older models use cl100k_base.
	if (origin === "openai" || /^(gpt-|o[134]|text-embedding-|chatgpt)/.test(id)) {
		if (
			/gpt-4o|gpt-4\.1|gpt-5|^o1\b|^o3\b|^o4\b|chatgpt-4o/.test(id) ||
			id.startsWith("o1-") ||
			id.startsWith("o3-") ||
			id.startsWith("o4-")
		) {
			return "o200k_base";
		}
		return "cl100k_base";
	}

	// Anthropic Claude — single proprietary tokenizer family.
	if (origin === "anthropic" || /claude/.test(id)) {
		return "claude";
	}

	// Google Gemini — proprietary tokenizer; also covers "google" origin.
	if (origin === "google" || origin === "gemini" || origin === "vertex" || /gemini/.test(id)) {
		return "gemini";
	}

	// Meta Llama — tokenizer differs between Llama 2 (32k), Llama 3 (128k),
	// and Llama 4 (200k) families. Check llama-2 / codellama before llama-3
	// because IDs like "codellama-34b" contain the substring "llama-3" via
	// "codellama-34b" → would false-positive the llama-3 branch otherwise.
	if (origin === "meta" || /llama/.test(id)) {
		if (/codellama|llama-?2\b|llama2/.test(id)) return "llama2";
		if (/llama-?4/.test(id)) return "llama4";
		if (/llama-?3|llama3/.test(id)) return "llama3";
		return "llama3"; // Default new llama.* to llama3 (safer recent assumption).
	}

	// Mistral / Mixtral — shared tokenizer family.
	if (origin === "mistral" || /mistral|mixtral|codestral|pixtral/.test(id)) {
		return "mistral";
	}

	// Cohere — Command / Embed / Rerank models share one tokenizer family.
	if (origin === "cohere" || /^command-|^embed-|^rerank-/.test(id)) {
		return "cohere";
	}

	// DeepSeek — proprietary tokenizer.
	if (origin === "deepseek" || /deepseek/.test(id)) {
		return "deepseek";
	}

	// Alibaba Qwen — proprietary tokenizer.
	if (origin === "alibaba" || origin === "qwen" || /\bqwen/.test(id)) {
		return "qwen";
	}

	return undefined;
}
