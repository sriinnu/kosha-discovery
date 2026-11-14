/**
 * kosha-discovery — Whether a model is still served.
 *
 * Catalogs mark a model `retired`, or keep it `deprecated` with a
 * `deprecationDate`: the UTC day it stops being served. Past that day it's
 * retired too, even if no catalog has flipped its status yet; routing,
 * `cheapest` and the proxy used to keep offering it.
 * @module
 */

import type { ModelCard } from "./types.js";

/** True when the model is retired, or its sunset day (UTC) has started. */
export function isRetired(model: Pick<ModelCard, "status" | "deprecationDate">, nowMs = Date.now()): boolean {
	if (model.status === "retired") return true;
	if (!model.deprecationDate) return false;
	const sunset = Date.parse(model.deprecationDate);
	return Number.isFinite(sunset) && sunset <= nowMs;
}
