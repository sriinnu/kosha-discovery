/**
 * kosha-discovery — Claude generation parsing and per-generation behaviour.
 *
 * One source of truth for "which Claude is this and what does it accept",
 * shared by the catalog feature inference (`model-features.ts`) and the
 * proxy's wire translator (`wire-anthropic.ts`). Keeping it in one module
 * means an OpenRouter-style `anthropic/claude-sonnet-4.6`, a Bedrock-style
 * `anthropic.claude-opus-4-8-v1:0`, and the bare `claude-opus-4-8` all
 * classify identically everywhere.
 * @module
 */

export interface ClaudeGeneration {
	family: "opus" | "sonnet" | "haiku" | "fable" | "mythos";
	major: number;
	minor: number;
}

/**
 * Normalize the many spellings of a Claude ID down to the bare family-first
 * form: strip a `vendor/` or `anthropic.` prefix, a Bedrock `-v1:0` suffix,
 * and turn dotted versions (`4.6`) into dashed (`4-6`).
 */
function normalizeClaudeId(modelId: string): string {
	return modelId
		.toLowerCase()
		.replace(/^.*\//, "")
		.replace(/^anthropic\./, "")
		.replace(/-v\d+:\d+$/, "")
		.replace(/\./g, "-");
}

/**
 * Parse the generation out of a family-first Claude ID such as
 * `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5-1`, a dated
 * `claude-haiku-4-5-20251001`, or a prefixed / dotted variant. Legacy
 * version-first IDs (`claude-3-5-sonnet-…`, `claude-2.1`) and non-Claude IDs
 * return `undefined`.
 */
export function parseClaudeGeneration(modelId: string): ClaudeGeneration | undefined {
	// Minor is 1-2 digits so an 8-digit date suffix (`-20250514`) is never
	// mistaken for a minor version.
	const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(normalizeClaudeId(modelId));
	if (!m) return undefined;
	return {
		family: m[1] as ClaudeGeneration["family"],
		major: Number(m[2]),
		minor: m[3] !== undefined ? Number(m[3]) : 0,
	};
}

function atLeast(gen: ClaudeGeneration, major: number, minor: number): boolean {
	return gen.major > major || (gen.major === major && gen.minor >= minor);
}

/** How a Claude model treats `temperature` / `top_p`. */
export type SamplingSupport = "both" | "one" | "none";

/**
 * Sampling parameters were removed on Opus 4.7 and every later model (Opus
 * 4.8, Opus 5, Sonnet 5, Fable, Mythos): sending them returns a 400. Every
 * Claude 4.x model accepts at most one of `temperature` / `top_p` (sending
 * both is a 400). Claude 3.x and unrecognized IDs accept both.
 */
export function claudeSamplingSupport(modelId: string): SamplingSupport {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return "both";
	if (atLeast(gen, 4, 7)) return "none";
	if (gen.major >= 4) return "one";
	return "both";
}

/** Anthropic's accepted `temperature` range; OpenAI's is 0..2. */
export const CLAUDE_TEMPERATURE_MAX = 1;

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Effort levels a generation accepts under `output_config.effort`; empty when
 * effort is unsupported. `xhigh` arrived with Opus 4.7; `max` with 4.6; in
 * the 4.5 generation only Opus 4.5 had an effort parameter at all (Sonnet
 * 4.5 and Haiku 4.5 reject it).
 */
export function claudeEffortLadder(modelId: string): readonly ClaudeEffort[] {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return [];
	if (atLeast(gen, 4, 7)) return ["low", "medium", "high", "xhigh", "max"];
	if (atLeast(gen, 4, 6)) return ["low", "medium", "high", "max"];
	if (atLeast(gen, 4, 5)) return gen.family === "opus" ? ["low", "medium", "high"] : [];
	return [];
}

/**
 * Last-assistant-turn prefill returns a 400 on Opus 4.6 / Sonnet 4.6 and every
 * later model. Older generations still accept a trailing assistant message.
 */
export function claudeSupportsPrefill(modelId: string): boolean {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return true;
	return !atLeast(gen, 4, 6);
}

/**
 * Native JSON-schema structured outputs (`output_config.format`) shipped with
 * the 4.5 generation (Sonnet 4.5, Haiku 4.5, Opus 4.1) and every model since.
 */
export function claudeSupportsNativeJsonSchema(modelId: string): boolean {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return false;
	if (atLeast(gen, 4, 5)) return true;
	return gen.family === "opus" && gen.major === 4 && gen.minor === 1;
}

/**
 * Claude Fable 5.1 and Claude Mythos 5.1 return a 400 for forced tool use
 * (`tool_choice` `any` / `tool`); everything else still honours it.
 */
export function claudeSupportsForcedToolChoice(modelId: string): boolean {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return true;
	if (gen.family !== "fable" && gen.family !== "mythos") return true;
	return !atLeast(gen, 5, 1);
}
