/**
 * kosha-discovery — Base discoverer abstraction.
 *
 * Provides shared HTTP fetching, timeout handling, and {@link ModelCard}
 * construction logic that every concrete provider discoverer inherits.
 * @module
 */

import type { CredentialResult, ModelCard, ProviderDiscoverer } from "../types.js";
import { assertCleanPayload } from "../security.js";

/** Safety cap for paginated model listing. */
export const MAX_MODELS_PER_PROVIDER = 10_000;

/** Common API-key patterns to redact from error messages. */
const API_KEY_PATTERN =
	/\b(sk-[A-Za-z0-9_-]{8,}|key-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._\-]{20,})\b/gi;

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

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const response = await fetch(url, {
					headers,
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

			// Wait before retrying (exponential backoff: 500ms, 1s, 2s)
			if (attempt < maxRetries - 1) {
				await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
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
		return (Number.isFinite(timeout) && timeout! > 0) ? timeout! : defaultMs;
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
