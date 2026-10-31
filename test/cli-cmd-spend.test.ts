/**
 * `kosha spend` window bounds: bad dates are errors, not "all time", and a
 * bare `--until` date includes that day.
 */

import { describe, expect, it } from "vitest";
import { parseWindowBound } from "../src/cli-cmd-spend.js";

describe("parseWindowBound", () => {
	it("falls back when the flag is absent", () => {
		expect(parseWindowBound(undefined, "since", Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
		expect(parseWindowBound(undefined, "until", Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
	});

	it("refuses a value that isn't a date instead of meaning all time", () => {
		expect(() => parseWindowBound("last-week", "since", 0)).toThrow(/--since needs a date/);
		expect(() => parseWindowBound(true, "until", 0)).toThrow(/--until needs a date/);
	});

	it("counts the whole day for a bare --until date", () => {
		expect(parseWindowBound("2026-10-31", "until", 0)).toBe(Date.parse("2026-11-01T00:00:00Z"));
		expect(parseWindowBound("2026-10-31", "since", 0)).toBe(Date.parse("2026-10-31T00:00:00Z"));
		expect(parseWindowBound("2026-10-31T12:00:00Z", "until", 0)).toBe(Date.parse("2026-10-31T12:00:00Z"));
	});
});
