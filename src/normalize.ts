/**
 * kosha-discovery (कोश) — Model ID normalization utilities.
 *
 * Provides functions to extract the originating model creator from a
 * compound model ID and to strip provider prefixes / version suffixes
 * so that IDs from different serving layers can be compared uniformly.
 * @module
 */

/**
 * Maps slash-separated namespace prefixes found in compound model IDs
 * (e.g. "anthropic/claude-opus-4-6") to canonical origin-provider slugs.
 *
 * Providers that use their own namespace directly keep that name; those
 * with unusual namespaces (e.g. "meta-llama") are mapped to a shorter slug.
 */
const PREFIX_TO_ORIGIN: Record<string, string> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	"meta-llama": "meta",
	meta: "meta",
	mistralai: "mistral",
	mistral: "mistral",
	cohere: "cohere",
	deepseek: "deepseek",
	qwen: "qwen",
	"01-ai": "01-ai",
	"x-ai": "xai",
	xai: "xai",
	amazon: "amazon",
	"amazon-nova": "amazon",
};

/**
 * Ordered list of [regex, originProvider] pairs for models whose IDs
 * do not contain a slash prefix but still have a recognisable pattern.
 * Evaluated in order; the first match wins.
 */
const PATTERN_TO_ORIGIN: Array<[RegExp, string]> = [
	[/^claude-/i, "anthropic"],
	[/^gpt-|^o[1-9](?:-|$)|^chatgpt-/i, "openai"],
	[/^dall-e/i, "openai"],
	[/^whisper|^tts-/i, "openai"],
	[/^gemini-/i, "google"],
	[/^llama/i, "meta"],
	[/^mistral|^codestral|^pixtral/i, "mistral"],
	[/^command-/i, "cohere"],
	[/^deepseek/i, "deepseek"],
	[/^qwen/i, "qwen"],
];

/**
 * Extract the origin provider (model creator) from a model ID.
 *
 * The function first attempts to resolve a slash-separated namespace prefix
 * (e.g. `"anthropic/claude-opus-4-6"` → `"anthropic"`).  When no prefix is
 * present it falls back to a set of well-known ID patterns.
 *
 * @param modelId - Raw model identifier as returned by a provider API.
 * @returns Canonical origin-provider slug, or `undefined` when the creator
 *          cannot be determined.
 *
 * @example
 * extractOriginProvider("anthropic/claude-opus-4-6") // "anthropic"
 * extractOriginProvider("openai/gpt-4o")             // "openai"
 * extractOriginProvider("google/gemini-2.5-pro")     // "google"
 * extractOriginProvider("meta-llama/llama-3.3-70b")  // "meta"
 * extractOriginProvider("claude-opus-4-6")           // "anthropic"
 * extractOriginProvider("gpt-4o")                    // "openai"
 * extractOriginProvider("gemini-2.5-pro")            // "google"
 * extractOriginProvider("unknown-model")             // undefined
 */
export function extractOriginProvider(modelId: string): string | undefined {
	if (!modelId) return undefined;

	// Check slash-separated prefix first.
	const slashIdx = modelId.indexOf("/");
	if (slashIdx !== -1) {
		const prefix = modelId.slice(0, slashIdx).toLowerCase();
		if (Object.prototype.hasOwnProperty.call(PREFIX_TO_ORIGIN, prefix)) {
			return PREFIX_TO_ORIGIN[prefix];
		}
	}

	// Fall back to known ID patterns (no prefix present).
	const bare = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId;
	for (const [pattern, origin] of PATTERN_TO_ORIGIN) {
		if (pattern.test(bare)) {
			return origin;
		}
	}

	return undefined;
}

/**
 * Normalise a model ID by stripping provider prefixes and version suffixes
 * so that the same underlying model — served from different providers or
 * released with different date stamps — yields the same base ID for
 * deduplication or alias matching.
 *
 * Transformations applied (in order):
 * 1. Strip everything up to and including the first `/` (provider prefix).
 * 2. Strip calendar-version suffixes of the form `-YYYY-MM-DD` or `-YYYYMMDD`.
 * 3. Strip the `:latest` tag used by Ollama.
 *
 * @param modelId - Raw model identifier (possibly namespaced / versioned).
 * @returns Cleaned base model ID ready for deduplication comparisons.
 *
 * @example
 * normalizeModelId("anthropic/claude-opus-4-6")          // "claude-opus-4-6"
 * normalizeModelId("openai/gpt-4o-2024-11-20")           // "gpt-4o"
 * normalizeModelId("meta-llama/llama-3.3-70b-instruct")  // "llama-3.3-70b-instruct"
 * normalizeModelId("claude-opus-4-6")                    // "claude-opus-4-6"
 * normalizeModelId("llama3.3:latest")                    // "llama3.3"
 */
export function normalizeModelId(modelId: string): string {
	if (!modelId) return modelId;

	// 1. Strip provider prefix (everything up to and including the first '/').
	const slashIdx = modelId.indexOf("/");
	let id = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId;

	// 2a. Strip ISO-style date suffixes: -YYYY-MM-DD (e.g. -2024-11-20).
	id = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");

	// 2b. Strip compact date suffixes: -YYYYMMDD (e.g. -20241120).
	id = id.replace(/-\d{8}$/, "");

	// 3. Strip Ollama :latest (and any other colon-tag).
	const colonIdx = id.indexOf(":");
	if (colonIdx !== -1) {
		id = id.slice(0, colonIdx);
	}

	return id;
}

/**
 * Extract a best-effort model version hint from an identifier.
 *
 * Supported patterns (in priority order):
 * 1. Provider suffix versions like `-v1:0` (Bedrock style)
 * 2. Date suffixes `YYYY-MM-DD` or `YYYYMMDD`
 * 3. Semantic fragments like `gpt-5.3-codex` -> `5.3`
 *
 * Returns `undefined` when no clear version-like segment is detected.
 */
export function extractModelVersion(modelId: string): string | undefined {
	if (!modelId) return undefined;

	const slashIdx = modelId.indexOf("/");
	const id = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId;

	// Bedrock/provider style suffixes, e.g. "...-v1:0"
	const providerSuffix = id.match(/-(v\d+(?::\d+)?)$/i);
	if (providerSuffix) {
		return providerSuffix[1];
	}

	// ISO date suffixes: ...-2024-11-20
	const isoDate = id.match(/-(\d{4}-\d{2}-\d{2})$/);
	if (isoDate) {
		return isoDate[1];
	}

	// Compact date suffixes: ...-20251001
	const compactDate = id.match(/-(\d{8})$/);
	if (compactDate) {
		return compactDate[1];
	}

	// Semantic version fragments like gpt-5.3-codex or model-v2.1
	const semverFragment = id.match(/(?:^|[-_])v?(\d+\.\d+(?:\.\d+)?)(?=$|[-_])/i);
	if (semverFragment) {
		return semverFragment[1];
	}

	return undefined;
}
