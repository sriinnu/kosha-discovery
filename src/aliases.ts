/**
 * kosha-discovery — Model alias resolution system.
 *
 * Provides short, memorable names that resolve to canonical model IDs.
 * Built-in aliases are kept in sync with the latest model releases.
 * @module
 */

/**
 * Curated default aliases mapping short names to canonical model IDs.
 *
 * These are production-ready and cover the most commonly referenced
 * models across major providers. Updated October 2026.
 *
 * Convention: a bare family name (`opus`, `sonnet`, `gemini-pro`) always
 * tracks the newest generally-available model in that family; a suffixed
 * form (`opus-4.8`, `sonnet-4`) pins a generation and is kept for
 * backward compatibility when the bare alias moves on.
 */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
	// ── Anthropic — Claude 5 family (latest as of Oct 2026) ──
	// Bare IDs, never date-suffixed: `claude-haiku-4-5` is the canonical
	// form; the dated `claude-haiku-4-5-20251001` snapshot still resolves via
	// normalizeModelId() for callers that pinned it.
	"fable": "claude-fable-5-1",
	"fable-5.1": "claude-fable-5-1",
	"fable-5": "claude-fable-5",
	"mythos": "claude-mythos-5-1",
	"mythos-5.1": "claude-mythos-5-1",
	"opus": "claude-opus-5-5",
	"opus-5.5": "claude-opus-5-5",
	"opus-5": "claude-opus-5",
	"opus-4": "claude-opus-4-8",
	"opus-4.8": "claude-opus-4-8",
	"opus-4.7": "claude-opus-4-7",
	"sonnet": "claude-sonnet-5-5",
	"sonnet-5.5": "claude-sonnet-5-5",
	"sonnet-5": "claude-sonnet-5",
	"sonnet-4": "claude-sonnet-4-6",
	"sonnet-4.6": "claude-sonnet-4-6",
	"haiku": "claude-haiku-4-5",
	"haiku-4.5": "claude-haiku-4-5",

	// ── OpenAI — GPT-6 / GPT-5 families, GPT-4o, and o-series reasoning ──
	// GPT-6 ships as named tiers (Astra > Sol > Luna) rather than
	// pro / mini / nano. Bare `gpt6` follows the mid tier, as `gpt5` does.
	// `o1`, `o3-mini` and `o4-mini` are deprecated upstream; the aliases stay
	// so callers that pinned them keep resolving.
	"gpt6": "gpt-6.1-sol",
	"gpt6-sol": "gpt-6.1-sol",
	"gpt6-astra": "gpt-6-astra",
	"gpt6-luna": "gpt-6-luna",
	"gpt5": "gpt-5",
	"gpt5-mini": "gpt-5-mini",
	"gpt5-nano": "gpt-5-nano",
	"gpt5-pro": "gpt-5-pro",
	"gpt4.1": "gpt-4.1",
	"gpt4o": "gpt-4o",
	"gpt4o-mini": "gpt-4o-mini",
	"o1": "o1",
	"o3": "o3",
	"o3-mini": "o3-mini",
	"o4-mini": "o4-mini",

	// ── Google — newest GA ID per tier ──
	// Pro is still 2.5: Gemini 3.1 Pro has only shipped as a preview, and
	// aliases never point at preview IDs — those get retired underneath you.
	"gemini-pro": "gemini-2.5-pro",
	"gemini-flash": "gemini-3.8-flash",
	"gemini-flash-2.5": "gemini-2.5-flash",
	"gemini-flash-lite": "gemini-3.5-flash-lite",
	"gemini-flash-lite-2.5": "gemini-2.5-flash-lite",

	// ── xAI — Grok family ──
	"grok": "grok-4.7",
	"grok-4.7": "grok-4.7",
	"grok-4.6": "grok-4.6",
	"grok-4.5": "grok-4.5",
	"grok-4.3": "grok-4.3",
	"grok-imagine": "grok-imagine-image",
	"grok-imagine-video": "grok-imagine-video",

	// ── TypeSafe — System One judgment models ──
	// These answer questions with typed values; they are not chat models, so
	// they never resolve from a bare family alias like `opus` or `gpt5`.
	"jev": "jev-latest",
	"jev-preview": "jev-preview",

	// ── Thinking Machines — Inkling (served over the Anthropic wire) ──
	"inkling": "thinkingmachines/Inkling",

	// ── Alibaba — Qwen family via Model Studio / DashScope ──
	"qwen-max": "qwen3.8-max",
	"qwen-plus": "qwen3.7-plus",
	"qwen-coder": "qwen3-coder-plus",

	// ── Other direct providers ──
	"jamba": "jamba-large",
	"jamba-mini": "jamba-mini",
	"solar": "solar-pro4",
	"mercury": "mercury-2.5",
	"doubao": "doubao-seed-2-1-pro-260628",

	// ── Moonshot — Kimi family ──
	"kimi": "kimi-k3",
	"kimi-k3": "kimi-k3",

	// ── Local — latest popular open-weight models for Ollama ──
	"qwen": "qwen3:8b",
	"llama": "llama3.3:latest",
	"codestral": "codestral:latest",
	"deepseek": "deepseek-r1:latest",

	// ── NVIDIA — Nemotron family via build.nvidia.com ──
	"nemotron-ultra": "nvidia/llama-3.1-nemotron-ultra-253b-v1",
	"nemotron-super": "nvidia/llama-3.3-nemotron-super-49b-v1.5",
	"nemotron-nano": "nvidia/llama-3.1-nemotron-nano-8b-v1",

	// ── Mistral AI — latest models ──
	"mistral-large": "mistral-large-latest",
	"mistral-small": "mistral-small-latest",
	"mistral-codestral": "codestral-latest",
	"pixtral": "pixtral-large-latest",

	// ── Groq — fast inference ──
	"groq-llama": "llama-3.3-70b-versatile",

	// ── Embeddings — OpenAI, Nomic, and Google embedding models ──
	"embed-small": "text-embedding-3-small",
	"embed-large": "text-embedding-3-large",
	"nomic": "nomic-embed-text",
	// `gemini-embed` stays on 001: embedding-2 is a different vector space, so
	// moving the bare alias would silently corrupt an existing index.
	"gemini-embed": "gemini-embedding-001",
	"gemini-embed-2": "gemini-embedding-2",
};

/**
 * Resolves short alias names to canonical model IDs.
 *
 * Built-in aliases from {@link DEFAULT_ALIASES} are merged with optional
 * user-provided overrides, where user overrides take precedence.
 */
export class AliasResolver {
	/** Internal map holding the merged alias -> canonical ID mappings. */
	private aliases: Map<string, string>;

	/**
	 * @param customAliases - Optional user overrides; these are merged on top
	 *                        of the built-in {@link DEFAULT_ALIASES} map.
	 */
	constructor(customAliases?: Record<string, string>) {
		this.aliases = new Map(Object.entries(DEFAULT_ALIASES));

		if (customAliases) {
			for (const [alias, modelId] of Object.entries(customAliases)) {
				this.aliases.set(alias, modelId);
			}
		}
	}

	/**
	 * Resolve an alias to its canonical model ID.
	 * Returns the input unchanged if no matching alias is found.
	 */
	resolve(nameOrAlias: string): string {
		return this.aliases.get(nameOrAlias) ?? nameOrAlias;
	}

	/**
	 * Find all aliases that point to the given canonical model ID.
	 */
	reverseAliases(modelId: string): string[] {
		const result: string[] = [];
		for (const [alias, target] of this.aliases) {
			if (target === modelId) {
				result.push(alias);
			}
		}
		return result;
	}

	/**
	 * Add or overwrite an alias mapping.
	 */
	addAlias(alias: string, modelId: string): void {
		this.aliases.set(alias, modelId);
	}

	/**
	 * Remove an alias mapping.
	 */
	removeAlias(alias: string): void {
		this.aliases.delete(alias);
	}

	/**
	 * Return a snapshot of the full alias map (defaults + custom).
	 */
	all(): Record<string, string> {
		return Object.fromEntries(this.aliases);
	}
}
