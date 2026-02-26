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
 * models across major providers. Updated February 2026.
 */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
	// ── Anthropic — Claude 4.6 family (latest as of Feb 2026) ──
	"opus": "claude-opus-4-6",
	"opus-4": "claude-opus-4-6",
	"sonnet": "claude-sonnet-4-6",
	"sonnet-4": "claude-sonnet-4-6",
	"haiku": "claude-haiku-4-5-20251001",
	"haiku-4.5": "claude-haiku-4-5-20251001",

	// ── OpenAI — latest reasoning and chat models ──
	"gpt4o": "gpt-4o",
	"gpt4o-mini": "gpt-4o-mini",
	"o1": "o1",
	"o3": "o3",
	"o3-mini": "o3-mini",
	"o4-mini": "o4-mini",

	// ── Google — Gemini 2.5 series ──
	"gemini-pro": "gemini-2.5-pro-preview-05-06",
	"gemini-flash": "gemini-2.5-flash-preview-04-17",
	"gemini-flash-lite": "gemini-2.0-flash-lite",

	// ── Local — latest popular open-weight models for Ollama ──
	"qwen": "qwen3:8b",
	"llama": "llama3.3:latest",
	"codestral": "codestral:latest",
	"deepseek": "deepseek-r1:latest",

	// ── Embeddings — OpenAI, Nomic, and Google embedding models ──
	"embed-small": "text-embedding-3-small",
	"embed-large": "text-embedding-3-large",
	"nomic": "nomic-embed-text",
	"gemini-embed": "gemini-embedding-001",
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
