/**
 * kosha-discovery — Base discoverer abstraction.
 *
 * Provides shared HTTP fetching, timeout handling, and {@link ModelCard}
 * construction logic that every concrete provider discoverer inherits.
 * @module
 */

import { assertCleanPayload } from "../security.js";
import type { CredentialResult, ModelCard, ProviderDiscoverer } from "../types.js";
import { getPublicSeed } from "./public-seed.js";

/** Safety cap for paginated model listing. */
export const MAX_MODELS_PER_PROVIDER = 10_000;

/**
 * Default User-Agent sent on every discovery request. Some provider APIs
 * throttle or block requests with no User-Agent more aggressively, so we
 * always identify ourselves. Callers can override by passing their own
 * `user-agent` header.
 */
export const KOSHA_USER_AGENT = "kosha-discovery (+https://github.com/sriinnu/kosha-discovery)";

/** Common API-key patterns to redact from error messages. */
const API_KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|key-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/gi;

/** Sanitize a response body before including it in an error message. */
function sanitizeErrorBody(raw: string, maxLen = 200): string {
	const redacted = raw.replace(API_KEY_PATTERN, "[REDACTED]");
	if (redacted.length <= maxLen) return redacted;
	return `${redacted.slice(0, maxLen)}…[truncated]`;
}

/**
 * Abstract base class for all provider discoverers.
 *
 * Subclasses only need to implement {@link discover} and set the three
 * readonly identity fields; the base class supplies `fetchJSON` for
 * HTTP calls and `makeCard` for building uniform {@link ModelCard} objects.
 */
export abstract class BaseDiscoverer implements ProviderDiscoverer {
	abstract readonly providerId: string;
	abstract readonly providerName: string;
	abstract readonly baseUrl: string;

	/**
	 * Query the provider's API and return a list of normalized model cards.
	 * @param credential - Resolved credential for authentication.
	 * @param options    - Optional per-request timeout override.
	 */
	abstract discover(credential: CredentialResult, options?: { timeout?: number }): Promise<ModelCard[]>;

	/**
	 * Fetch JSON from a URL with timeout and automatic retry on transient errors.
	 *
	 * Retries up to {@link maxRetries} times with exponential backoff on:
	 * - Network failures (fetch throws)
	 * - Timeout / abort errors
	 * - Server errors (HTTP 5xx)
	 *
	 * Client errors (4xx) are thrown immediately without retry.
	 */
	protected async fetchJSON<T>(url: string, headers?: Record<string, string>, timeoutMs = 10_000): Promise<T> {
		const maxRetries = 3;
		const baseDelayMs = 500;
		let lastError: Error | undefined;

		// Always identify ourselves; let an explicit caller header win. Header
		// keys are matched case-insensitively so a caller-supplied "User-Agent"
		// is not silently shadowed by our lowercase default.
		const hasUserAgent = headers && Object.keys(headers).some((k) => k.toLowerCase() === "user-agent");
		const requestHeaders: Record<string, string> = hasUserAgent
			? { ...headers }
			: { "user-agent": KOSHA_USER_AGENT, ...headers };

		// Global deadline across ALL retries (incl. backoff sleeps). Without
		// this, a server that is slow-but-not-dead can stretch one fetchJSON
		// call to ~timeoutMs × maxRetries + backoff (~31s at defaults), and a
		// full discovery pass multiplies that across every provider. The
		// per-attempt timeout below still bounds an individual hung socket.
		const deadline = Date.now() + timeoutMs * 2;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw lastError ?? new Error(`${this.providerName} API request exceeded the overall deadline`);
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));

			try {
				const response = await fetch(url, {
					headers: requestHeaders,
					signal: controller.signal,
				});

				if (!response.ok) {
					const body = await response.text().catch(() => "");
					const safeBody = body ? sanitizeErrorBody(body) : "";
					const err = new Error(
						`${this.providerName} API error: ${response.status} ${response.statusText}${safeBody ? ` — ${safeBody}` : ""}`,
					);

					// 4xx client errors are not transient — fail immediately
					if (response.status >= 400 && response.status < 500) {
						throw err;
					}

					// 5xx server errors are retryable
					lastError = err;
				} else {
					const data = (await response.json()) as T;
					assertCleanPayload(data, `${this.providerName} API`);
					return data;
				}
			} catch (error: unknown) {
				if (error instanceof DOMException && error.name === "AbortError") {
					lastError = new Error(`${this.providerName} API request timed out after ${timeoutMs}ms`);
				} else if (error instanceof Error) {
					// 4xx errors rethrown above will have already propagated
					lastError = error;
				} else {
					lastError = new Error(String(error));
				}
			} finally {
				clearTimeout(timer);
			}

			// Wait before retrying (exponential backoff: 500ms, 1s, 2s), but
			// never sleep past the global deadline.
			if (attempt < maxRetries - 1) {
				const backoff = Math.min(baseDelayMs * 2 ** attempt, Math.max(0, deadline - Date.now()));
				if (backoff <= 0) break;
				await new Promise((resolve) => setTimeout(resolve, backoff));
			}
		}

		throw lastError ?? new Error(`${this.providerName} API request failed after ${maxRetries} attempts`);
	}

	/**
	 * Create a ModelCard with sensible defaults for missing fields.
	 *
	 * - `originProvider` defaults to `partial.provider` when not explicitly set,
	 *   which is correct for first-party providers (e.g. "anthropic" serving its
	 *   own Claude models). Aggregators like openrouter or managed services like
	 *   bedrock/vertex should pass an explicit `originProvider` to distinguish
	 *   the serving layer from the original model creator.
	 * - `region` and `projectId` are passed through unchanged when present
	 *   (used by Bedrock and Vertex AI respectively).
	 */
	/** Validate and normalise a timeout value. Returns defaultMs when invalid. */
	protected validateTimeout(timeout: number | undefined, defaultMs = 10_000): number {
		return Number.isFinite(timeout) && timeout! > 0 ? timeout! : defaultMs;
	}

	/**
	 * Union API discovery results with the public seed for this provider.
	 *
	 * Merge rules per (providerId, modelId):
	 *  - **Identity wins from API.** If the API returned the model, the API
	 *    entry's metadata (name, capabilities, mode, context window) is the
	 *    authoritative description of "what this model is for this account".
	 *  - **Pricing falls back to the seed.** Native list endpoints
	 *    (`/v1/models` on Anthropic, OpenAI, Google) return *no pricing*.
	 *    The seed (models.dev primary, LiteLLM filler) does. So when the
	 *    API stub has no pricing and the seed entry does, we lift the seed's
	 *    pricing onto the API entry.
	 *  - **Seed-only models survive as filler.** Preview tiers, deprecated-
	 *    but-still-priced SKUs, region-gated entries that the API doesn't
	 *    list — keep them so consumers can still resolve historical IDs.
	 *
	 * Why this matters: without the pricing fallback, the same model can flip
	 * between two different prices depending on whether `/v1/models` was
	 * reachable when `kosha update` ran. That's a same-day-instability bug
	 * for any downstream that locks pricing at midnight (tokmeter et al).
	 *
	 * Failures in fetching the seed are swallowed — the API result still
	 * stands on its own. Pricing-degraded fallback is layered on at the
	 * registry-runtime merge step.
	 */
	protected async mergeWithPublicSeed(apiCards: ModelCard[]): Promise<ModelCard[]> {
		try {
			const seeds = await getPublicSeed(this.providerId);
			if (seeds.length === 0) return apiCards;
			const seedById = new Map(seeds.map((s) => [s.id, s]));
			const enriched = apiCards.map((api) => {
				const seed = seedById.get(api.id);
				if (!seed) return api;
				const apiHasPricing = !!api.pricing || !!api.originPricing;
				if (apiHasPricing) return api;
				return {
					...api,
					pricing: seed.pricing,
					originPricing: seed.originPricing,
				};
			});
			const apiIds = new Set(apiCards.map((c) => c.id));
			const filler = seeds.filter((s) => !apiIds.has(s.id));
			return [...enriched, ...filler];
		} catch {
			return apiCards;
		}
	}

	protected makeCard(partial: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
		const capabilities = partial.capabilities ?? ["chat"];
		return {
			name: partial.id,
			mode: "chat",
			capabilities,
			rawCapabilities: partial.rawCapabilities ?? [...capabilities],
			contextWindow: 0,
			maxOutputTokens: 0,
			aliases: [],
			discoveredAt: Date.now(),
			source: "api",
			// originProvider falls back to the serving provider when the caller
			// does not supply a more-specific original creator.
			originProvider: partial.originProvider ?? partial.provider,
			...partial,
		};
	}
}
