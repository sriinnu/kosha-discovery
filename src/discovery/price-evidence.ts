/**
 * kosha-discovery — What each source said a model costs.
 *
 * The merge that builds a card keeps one price. To tell a real price move from a
 * bad publish, the manifest also needs to know whether anything else agrees.
 * @module
 */

import type { ModelCard } from "../types.js";

/** One source's input and output rates for a model. */
export interface PriceEvidence {
	source: "models.dev" | "litellm" | "provider-api";
	inputPerMillion: number;
	outputPerMillion: number;
}

/**
 * Past this relative gap, two sources disagree. Of 135 models listed by both
 * models.dev and LiteLLM on 2026-11-04, 124 matched exactly and the other 11
 * differed by over 25%, with nothing in between. So 5% clears rounding without
 * letting a believable lie through as agreement.
 */
export const PRICE_AGREEMENT_TOLERANCE = 0.05;

export type PriceAgreement = "agree" | "disagree" | "single";

/** A card's rates as evidence from `source`. A catalog's $0 isn't a price (see
 *  price-trust.ts), so it testifies to nothing. */
export function evidenceFrom(card: ModelCard, source: PriceEvidence["source"]): PriceEvidence | null {
	const input = card.pricing?.inputPerMillion;
	const output = card.pricing?.outputPerMillion;
	if (typeof input !== "number" || typeof output !== "number" || (input === 0 && output === 0)) return null;
	return { source, inputPerMillion: input, outputPerMillion: output };
}

function gap(a: number, b: number): number {
	if (a === b) return 0;
	return Math.abs(a - b) / Math.max(a, b);
}

/** Whether a model's sources back each other up. Most models have one source,
 *  and nothing is stored for those, so no evidence reads as "single". */
export function priceAgreement(evidence: PriceEvidence[] | undefined): PriceAgreement {
	if (!evidence || evidence.length < 2) return "single";
	for (let i = 0; i < evidence.length; i++) {
		for (let j = i + 1; j < evidence.length; j++) {
			const a = evidence[i];
			const b = evidence[j];
			if (
				gap(a.inputPerMillion, b.inputPerMillion) > PRICE_AGREEMENT_TOLERANCE ||
				gap(a.outputPerMillion, b.outputPerMillion) > PRICE_AGREEMENT_TOLERANCE
			) {
				return "disagree";
			}
		}
	}
	return "agree";
}
