/**
 * kosha-discovery — Which prices kosha can trust.
 *
 * Most prices come from community catalogs. A $0/$0 price there is either a
 * genuinely free model or a mistake (or a poisoned entry), and nothing in the
 * card tells the two apart. Every ranking surface treats such a price as
 * unknown, so it can never come out "cheapest" by default.
 * @module
 */

import { getProviderDescriptor } from "./provider-catalog.js";
import type { ModelCard, ModelPricing } from "./types.js";

/** Rates billed in a unit other than text tokens. */
const OTHER_UNIT_RATES = [
	"imageInputPerImage",
	"imageOutputPerImage",
	"audioInputPerMillion",
	"audioOutputPerMillion",
	"audioInputPerSecond",
	"audioOutputPerSecond",
	"videoInputPerSecond",
	"videoOutputPerSecond",
	"videoInputPerMillion",
	"webSearchPerThousandRequests",
	"mapsSearchPerThousandRequests",
	"requestPerThousand",
	"inputPerMillionCharacters",
	"outputPerMillionCharacters",
] as const satisfies readonly (keyof ModelPricing)[];

/**
 * True when text input and output are $0, no rate in another unit is set,
 * and nothing other than a catalog vouches for it. Two exceptions are real
 * $0: local runtimes (you run them), and OpenRouter `:free` ids (the provider
 * bills by id, so a `:free` route costs nothing whatever the catalog says).
 */
export function isUnverifiedZeroPrice(model: ModelCard): boolean {
	const pricing = model.pricing;
	if (pricing?.inputPerMillion !== 0 || pricing.outputPerMillion !== 0) return false;
	// Video, image, audio and search models show $0 per token and bill per
	// second, per image or per call; a positive rate in one of those units is
	// a real price. Cache, batch and long-context rates don't count: they are
	// discounts or surcharges on the token price, so a positive cache rate
	// beside $0 input (seen live on gemini-exp-1206) is a catalog error.
	if (OTHER_UNIT_RATES.some((key) => (pricing[key] ?? 0) > 0)) return false;
	if (model.provider === "openrouter" && model.id.endsWith(":free")) return false;
	return getProviderDescriptor(model.provider)?.isLocal !== true;
}
