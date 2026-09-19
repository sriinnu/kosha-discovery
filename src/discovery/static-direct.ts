/**
 * kosha-discovery — Static first-party model catalogs.
 *
 * These lists provide baseline model coverage for direct providers when users
 * do not have API keys configured. They intentionally focus on high-signal
 * models and let enrichment fill pricing/context metadata when available.
 * @module
 */

import type { ModelMode } from "../types.js";

export interface StaticModelSeed {
	id: string;
	name: string;
	mode: ModelMode;
	capabilities: string[];
	contextWindow?: number;
	maxOutputTokens?: number;
	maxInputTokens?: number;
}

/**
 * Curated OpenAI models for unauthenticated/offline discovery mode.
 *
 * Every ID that {@link DEFAULT_ALIASES} points at must appear here, otherwise
 * `kosha model gpt5` resolves to a canonical ID with no card behind it on a
 * machine with no key and no network. Context / output limits are left to the
 * public-seed and LiteLLM enrichment passes.
 */
export const STATIC_OPENAI_MODELS: readonly StaticModelSeed[] = [
	{
		id: "gpt-5",
		name: "GPT-5",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "reasoning", "structured_output", "code", "nlu"],
	},
	{
		id: "gpt-5-mini",
		name: "GPT-5 mini",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "reasoning", "structured_output", "code", "nlu"],
	},
	{
		id: "gpt-5-nano",
		name: "GPT-5 nano",
		mode: "chat",
		capabilities: ["chat", "function_calling", "structured_output", "code", "nlu"],
	},
	{
		id: "gpt-5-pro",
		name: "GPT-5 pro",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "reasoning", "structured_output", "code", "nlu"],
	},
	{
		id: "gpt-4.1",
		name: "GPT-4.1",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "structured_output", "code", "nlu"],
	},
	{
		id: "o3",
		name: "o3",
		mode: "chat",
		capabilities: ["chat", "code", "nlu"],
	},
	{
		id: "o3-mini",
		name: "o3-mini",
		mode: "chat",
		capabilities: ["chat", "code", "nlu"],
	},
	{
		id: "o4-mini",
		name: "o4-mini",
		mode: "chat",
		capabilities: ["chat", "code", "nlu"],
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "code", "nlu"],
	},
	{
		id: "gpt-4o-mini",
		name: "GPT-4o Mini",
		mode: "chat",
		capabilities: ["chat", "function_calling", "code", "nlu"],
	},
	{
		id: "text-embedding-3-small",
		name: "Text Embedding 3 Small",
		mode: "embedding",
		capabilities: ["embedding"],
	},
	{
		id: "text-embedding-3-large",
		name: "Text Embedding 3 Large",
		mode: "embedding",
		capabilities: ["embedding"],
	},
	{
		id: "dall-e-3",
		name: "DALL-E 3",
		mode: "image",
		capabilities: ["image_generation"],
	},
	{
		id: "whisper-1",
		name: "Whisper 1",
		mode: "audio",
		capabilities: ["speech_to_text"],
	},
];

/**
 * Capability tags shared by every current-generation Claude chat model
 * (4.5 and later): multimodal input, tool use, adaptive thinking, native
 * JSON-schema structured outputs, and prompt caching.
 */
const CLAUDE_CURRENT_CAPABILITIES: readonly string[] = [
	"chat",
	"vision",
	"function_calling",
	"reasoning",
	"structured_output",
	"prompt_caching",
	"code",
	"nlu",
];

/**
 * Curated Anthropic models for unauthenticated/offline discovery mode.
 *
 * Context / output limits are the documented Anthropic first-party values
 * (Sep 2026): 1M context and 128K output across the Claude 5 and Opus /
 * Sonnet 4.6+ tiers, 200K / 64K for Haiku 4.5. Pricing is left to the
 * public-seed / LiteLLM enrichment pass so a price change never requires a
 * code release.
 */
export const STATIC_ANTHROPIC_MODELS: readonly StaticModelSeed[] = [
	{
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		mode: "chat",
		capabilities: [...CLAUDE_CURRENT_CAPABILITIES],
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		mode: "chat",
		capabilities: [...CLAUDE_CURRENT_CAPABILITIES],
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		mode: "chat",
		capabilities: [...CLAUDE_CURRENT_CAPABILITIES],
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		mode: "chat",
		capabilities: [...CLAUDE_CURRENT_CAPABILITIES],
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		mode: "chat",
		capabilities: [...CLAUDE_CURRENT_CAPABILITIES],
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		mode: "chat",
		capabilities: [...CLAUDE_CURRENT_CAPABILITIES],
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		mode: "chat",
		capabilities: [...CLAUDE_CURRENT_CAPABILITIES],
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
	},
];

/**
 * Curated Google/Gemini models for unauthenticated/offline discovery mode.
 *
 * These are the GA IDs that {@link DEFAULT_ALIASES} resolves to. The dated
 * `-preview-` snapshots this list used to carry are retired and no longer
 * accept requests, so they are not worth offering as a fallback.
 */
export const STATIC_GOOGLE_MODELS: readonly StaticModelSeed[] = [
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "reasoning", "structured_output", "code", "nlu"],
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "reasoning", "structured_output", "code", "nlu"],
	},
	{
		id: "gemini-2.5-flash-lite",
		name: "Gemini 2.5 Flash-Lite",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "structured_output", "code", "nlu"],
	},
	{
		id: "gemini-embedding-001",
		name: "Gemini Embedding 001",
		mode: "embedding",
		capabilities: ["embedding"],
	},
];

/**
 * Curated xAI models for unauthenticated/offline discovery mode.
 *
 * The public catalogs cover xAI, so this list only has to carry the IDs the
 * built-in aliases resolve to, for the case where neither catalog is reachable.
 */
export const STATIC_XAI_MODELS: readonly StaticModelSeed[] = [
	{
		id: "grok-4.6",
		name: "Grok 4.6",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "reasoning", "structured_output", "code", "nlu"],
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "reasoning", "structured_output", "code", "nlu"],
	},
	{
		id: "grok-4.3",
		name: "Grok 4.3",
		mode: "chat",
		capabilities: ["chat", "vision", "function_calling", "reasoning", "structured_output", "code", "nlu"],
	},
	{
		id: "grok-imagine-image",
		name: "Grok Imagine (image)",
		mode: "image",
		capabilities: ["image_generation"],
	},
	{
		id: "grok-imagine-video",
		name: "Grok Imagine (video)",
		mode: "video",
		capabilities: ["video_generation"],
	},
];

/**
 * Curated TypeSafe System One models.
 *
 * TypeSafe appears in neither models.dev nor LiteLLM, so this is the only
 * keyless source for it. `jev-latest` and `jev-preview` are moving aliases the
 * API itself advertises; the pinned version is listed so a caller who pinned it
 * still resolves. Limits and pricing live in `typesafe.ts` next to the
 * discoverer that applies them.
 */
export const STATIC_TYPESAFE_MODELS: readonly StaticModelSeed[] = [
	{
		id: "jev-latest",
		name: "Jev (latest)",
		mode: "judgment",
		capabilities: ["judgment", "structured_output", "nlu", "classification"],
		contextWindow: 64_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 0,
	},
	{
		id: "jev-preview",
		name: "Jev (preview)",
		mode: "judgment",
		capabilities: ["judgment", "structured_output", "nlu", "classification"],
		contextWindow: 64_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 0,
	},
	{
		id: "jev-1.13.0",
		name: "Jev 1.13.0",
		mode: "judgment",
		capabilities: ["judgment", "structured_output", "nlu", "classification"],
		contextWindow: 64_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 0,
	},
];
