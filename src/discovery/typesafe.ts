/**
 * kosha-discovery — TypeSafe (System One / Jev) provider discoverer.
 *
 * TypeSafe is not a chat provider. Its System One models answer a *question*
 * about supplied state and return a typed value — a choice with a probability
 * distribution, a boolean-ish probability (Noul), or a score on described
 * levels. Nothing is generated; output tokens are free because there are none
 * to bill. That is why these cards carry `mode: "judgment"` rather than
 * `"chat"`: a router that treats Jev as a chat model will send it prompts it
 * cannot answer.
 *
 * The list endpoint is `GET /v1/models`, which returns its own envelope —
 * `{ models: [{ name, description, release_date }] }` — not the OpenAI
 * `{ data: [...] }` shape, so this discoverer does not extend
 * {@link OpenAICompatibleDiscoverer}.
 * @module
 */

import type { CredentialResult, ModelCard } from "../types.js";
import { BaseDiscoverer } from "./base.js";
import { STATIC_TYPESAFE_MODELS } from "./static-direct.js";

/** A single entry from `GET /v1/models`. */
interface TypeSafeModel {
	name: string;
	description?: string;
	release_date?: string;
}

/** Response envelope from `GET /v1/models`. */
interface TypeSafeListResponse {
	models: TypeSafeModel[];
}

/**
 * Capability tags for a System One model.
 *
 * `judgment` is the routable tag; `structured_output` is literal here — the
 * response *is* a typed structure, not text coaxed into one. `nlu` records
 * that the input is natural language. Deliberately absent: `chat` (no
 * conversation), `function_calling` (the caller owns control flow), `vision`
 * (text-only input).
 */
const SYSTEM_ONE_CAPABILITIES: readonly string[] = ["judgment", "structured_output", "nlu", "classification"];

/**
 * Documented System One limits (Sep 2026): 64k tokens per request, of which
 * `state` plus the longest question may occupy 32k.
 */
const SYSTEM_ONE_CONTEXT_WINDOW = 64_000;
const SYSTEM_ONE_STATE_BUDGET = 32_000;

/**
 * Published Jev pricing: $42 per *billion* input tokens — $0.042 per million —
 * and no output charge, since a typed answer emits no billable completion.
 */
const SYSTEM_ONE_INPUT_PER_MILLION = 0.042;

/**
 * Discovers TypeSafe System One models.
 *
 * The API lists moving aliases (`jev-latest`, `jev-preview`) rather than pinned
 * versions, so the static seed supplies the pinned ID as filler and the API
 * result stays authoritative for what the key can actually reach.
 */
export class TypeSafeDiscoverer extends BaseDiscoverer {
	readonly providerId = "typesafe";
	readonly providerName = "TypeSafe";
	readonly baseUrl = "https://api.typesafe.ai";

	async discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]> {
		const apiKey = credential.apiKey ?? credential.accessToken;
		if (!apiKey) {
			// TypeSafe is absent from both public catalogs, so the curated list is
			// the only keyless answer. It is small and version-pinned by hand.
			return this.staticFallbackModels();
		}

		const timeoutMs = this.validateTimeout(options?.timeout);
		const response = await this.fetchJSON<TypeSafeListResponse>(
			`${this.baseUrl}/v1/models`,
			{ Authorization: `Bearer ${apiKey}` },
			timeoutMs,
		);

		const models = Array.isArray(response.models) ? response.models : [];
		const apiCards = models
			.filter((model): model is TypeSafeModel => typeof model?.name === "string" && model.name.length > 0)
			.map((model) => this.toModelCard(model));

		if (apiCards.length === 0) return this.staticFallbackModels();

		// Keep curated entries the account cannot see (pinned versions) as filler
		// so a caller who pinned `jev-1.13.0` still resolves it.
		const seen = new Set(apiCards.map((card) => card.id));
		return [...apiCards, ...this.staticFallbackModels().filter((card) => !seen.has(card.id))];
	}

	/** Build a card from a live API entry. */
	private toModelCard(model: TypeSafeModel): ModelCard {
		return this.makeCard({
			id: model.name,
			name: this.displayName(model.name),
			provider: this.providerId,
			mode: "judgment",
			capabilities: [...SYSTEM_ONE_CAPABILITIES],
			contextWindow: SYSTEM_ONE_CONTEXT_WINDOW,
			maxInputTokens: SYSTEM_ONE_STATE_BUDGET,
			// A typed judgment is the whole response; there is no generated
			// completion to cap, and TypeSafe bills nothing for output.
			maxOutputTokens: 0,
			pricing: { inputPerMillion: SYSTEM_ONE_INPUT_PER_MILLION, outputPerMillion: 0 },
		});
	}

	/** `jev-latest` → `Jev (latest)`; `jev-1.13.0` → `Jev 1.13.0`. */
	private displayName(id: string): string {
		const match = /^jev-(.+)$/i.exec(id);
		if (!match) return id;
		const suffix = match[1];
		return /^[\d.]+$/.test(suffix) ? `Jev ${suffix}` : `Jev (${suffix})`;
	}

	/** Curated fallback used when no credential is present. */
	private staticFallbackModels(): ModelCard[] {
		return STATIC_TYPESAFE_MODELS.map((model) =>
			this.makeCard({
				id: model.id,
				name: model.name,
				provider: this.providerId,
				mode: model.mode,
				capabilities: [...model.capabilities],
				contextWindow: model.contextWindow ?? SYSTEM_ONE_CONTEXT_WINDOW,
				maxOutputTokens: model.maxOutputTokens ?? 0,
				maxInputTokens: model.maxInputTokens ?? SYSTEM_ONE_STATE_BUDGET,
				pricing: { inputPerMillion: SYSTEM_ONE_INPUT_PER_MILLION, outputPerMillion: 0 },
				source: "manual",
			}),
		);
	}
}
