/**
 * kosha-discovery — Base discoverer abstraction.
 *
 * Provides shared HTTP fetching, timeout handling, and {@link ModelCard}
 * construction logic that every concrete provider discoverer inherits.
 * @module
 */

import type { CredentialResult, ModelCard, ProviderDiscoverer } from "../types.js";

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
	 * Fetch JSON from a URL with timeout support via AbortController.
	 * Throws descriptive errors on network failure or non-OK status.
	 */
	protected async fetchJSON<T>(url: string, headers?: Record<string, string>, timeoutMs = 10_000): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const response = await fetch(url, {
				headers,
				signal: controller.signal,
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(
					`${this.providerName} API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
				);
			}

			return (await response.json()) as T;
		} catch (error: unknown) {
			if (error instanceof DOMException && error.name === "AbortError") {
				throw new Error(`${this.providerName} API request timed out after ${timeoutMs}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
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
	protected makeCard(partial: Partial<ModelCard> & { id: string; provider: string }): ModelCard {
		return {
			name: partial.id,
			mode: "chat",
			capabilities: ["chat"],
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
