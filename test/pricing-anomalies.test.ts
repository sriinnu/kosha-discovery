import { describe, expect, it } from "vitest";
import { type PricingAnomaly, unloggedAnomalies } from "../src/registry-runtime.js";

const move = (previous: number, current: number, key = "deepseek:deepseek-flash"): PricingAnomaly => ({
	ts: 1,
	key,
	field: "input",
	side: "proxy",
	previous,
	current,
	deltaPct: (current - previous) / previous,
	promo: false,
});

describe("unloggedAnomalies", () => {
	it("drops the move a quarantined price repeats on every export", () => {
		expect(unloggedAnomalies([move(0.15, 0.3)], [move(0.15, 0.3)])).toEqual([]);
	});

	it("keeps a first move, and a price that went away and came back", () => {
		expect(unloggedAnomalies([], [move(0.15, 0.3)])).toHaveLength(1);
		expect(unloggedAnomalies([move(0.15, 0.3), move(0.3, 0.15)], [move(0.15, 0.3)])).toHaveLength(1);
	});

	it("tracks each model separately", () => {
		expect(unloggedAnomalies([move(1, 2, "a:x")], [move(1, 2, "b:y")])).toHaveLength(1);
	});
});
