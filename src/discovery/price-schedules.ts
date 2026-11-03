/**
 * kosha-discovery — Time-of-day pricing.
 *
 * DeepSeek charges half price outside its peak hours, and no catalog carries
 * that: they publish one rate, and which one has changed over time. So the
 * rates live here, cited, with both sides of the schedule, and they replace
 * whatever a catalog said.
 *
 * Known gap: DeepSeek also treats Chinese public holidays as off-peak. That
 * calendar isn't modelled, so a weekday holiday is billed at the peak rate
 * during peak hours.
 * @module
 */

import type { ModelCard, ModelPricing, PricingSchedule } from "../types.js";

const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";

/** Monday to Friday, 01:00–04:00 and 06:00–10:00 UTC. Checked 2026-11-03. */
const DEEPSEEK_PEAK_WINDOWS: PricingSchedule["peakWindows"] = [
	{ days: [1, 2, 3, 4, 5], startHourUtc: 1, endHourUtc: 4 },
	{ days: [1, 2, 3, 4, 5], startHourUtc: 6, endHourUtc: 10 },
];

interface ScheduledPrice {
	providerId: string;
	modelId: string;
	peak: Pick<ModelPricing, "inputPerMillion" | "outputPerMillion" | "cacheReadPerMillion">;
	offPeak: PricingSchedule["offPeak"];
	peakWindows: PricingSchedule["peakWindows"];
	source: string;
}

export const SCHEDULED_PRICES: readonly ScheduledPrice[] = [
	{
		providerId: "deepseek",
		modelId: "deepseek-flash",
		peak: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006 },
		offPeak: { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003 },
		peakWindows: DEEPSEEK_PEAK_WINDOWS,
		source: DEEPSEEK_PRICING_URL,
	},
	{
		providerId: "deepseek",
		modelId: "deepseek-v4-pro",
		peak: { inputPerMillion: 1.32, outputPerMillion: 3.96, cacheReadPerMillion: 0.044 },
		offPeak: { inputPerMillion: 0.66, outputPerMillion: 1.98, cacheReadPerMillion: 0.022 },
		peakWindows: DEEPSEEK_PEAK_WINDOWS,
		source: DEEPSEEK_PRICING_URL,
	},
];

/** Give each listed model its peak rates and its schedule. Others are untouched. */
export function applyPriceSchedules(
	cards: ModelCard[],
	schedules: readonly ScheduledPrice[] = SCHEDULED_PRICES,
): ModelCard[] {
	return cards.map((card) => {
		const match = schedules.find((s) => s.providerId === card.provider && s.modelId === card.id);
		if (!match) return card;
		return {
			...card,
			pricing: {
				...card.pricing,
				...match.peak,
				schedule: {
					offPeak: match.offPeak,
					peakWindows: match.peakWindows,
					source: match.source,
				},
			},
		};
	});
}
