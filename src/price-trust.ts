/**
 * kosha-discovery — Which prices kosha can trust.
 *
 * Most prices come from community catalogs. A $0 token price there is either
 * a genuinely free model or a mistake (or a poisoned entry), and nothing in
 * the card tells the two apart. The proxy, which costs chat by tokens,
 * refuses such a route under a budget, and every ranking puts a $0 score
 * built on it after the priced ones, so it can never come out "cheapest".
 * @module
 */

import { getProviderDescriptor } from "./provider-catalog.js";
import type { ModelCard } from "./types.js";

/**
 * True when input and output tokens are both $0 and nothing other than a
 * catalog vouches for it. Two exceptions are real $0: local runtimes (you run
 * them), and OpenRouter `:free` ids (the provider bills by id, so a `:free`
 * route costs nothing whatever the catalog says).
 *
 * A provider's own API doesn't vouch for $0 either: some adapters fill a
 * token rate the API left out with 0 (Vercel's does), so a live $0 can be
 * an unknown too.
 *
 * Only token rates count. The proxy estimates and records chat spend from
 * them alone, so an image or cache rate beside $0 tokens (a cache rate like
 * that was seen live on gemini-exp-1206) would still pass a budget as free.
 * Rankings judge per-image or per-second models by the score for the
 * query instead (see registryCheapestModels).
 */
export function isUnverifiedZeroPrice(model: ModelCard): boolean {
	const pricing = model.pricing;
	if (pricing?.inputPerMillion !== 0 || pricing.outputPerMillion !== 0) return false;
	if (model.provider === "openrouter" && model.id.endsWith(":free")) return false;
	return getProviderDescriptor(model.provider)?.isLocal !== true;
}
