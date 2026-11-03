import { describe, expect, it } from "vitest";
import { applyPriceSchedules } from "../../src/discovery/price-schedules.js";
import type { ModelCard } from "../../src/types.js";

const card = (provider: string, id: string, inputPerMillion: number) =>
	({
		id,
		provider,
		pricing: { inputPerMillion, outputPerMillion: 1, batchInputPerMillion: 9 },
	}) as unknown as ModelCard;

describe("applyPriceSchedules", () => {
	it("sets peak rates and the schedule, whichever rate the catalog published", () => {
		for (const published of [0.15, 0.3]) {
			const [out] = applyPriceSchedules([card("deepseek", "deepseek-flash", published)]);
			expect(out.pricing?.inputPerMillion).toBe(0.3);
			expect(out.pricing?.outputPerMillion).toBe(1.2);
			expect(out.pricing?.cacheReadPerMillion).toBe(0.006);
			expect(out.pricing?.schedule?.offPeak.inputPerMillion).toBe(0.15);
			expect(out.pricing?.schedule?.peakWindows).toHaveLength(2);
			expect(out.pricing).toHaveProperty("batchInputPerMillion", 9);
		}
	});

	it("leaves the same model on another provider alone", () => {
		const [out] = applyPriceSchedules([card("openrouter", "deepseek-flash", 0.02)]);
		expect(out.pricing?.inputPerMillion).toBe(0.02);
		expect(out.pricing?.schedule).toBeUndefined();
	});
});
