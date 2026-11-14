/**
 * The provider and plan counts quoted in the published text (README, npm
 * description, MCP registry manifest, SKILL.md) must match the catalog. They
 * drifted once already: 1.15.0 shipped saying 22 plans when there were 21.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../src/provider-catalog.js";
import { SUBSCRIPTION_PLANS } from "../src/subscription-plans.js";

const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** Pay-as-you-go providers and local runtimes: every catalog entry that isn't a plan. */
const providers = PROVIDER_CATALOG.filter((d) => !d.subscriptionPlan).length;
const plans = SUBSCRIPTION_PLANS.length;

/** "46 providers", "46 AI providers", "46 pay-as-you-go providers". */
const PROVIDER_CLAIM = /\b(\d+) (?:AI |pay-as-you-go )?providers\b/g;
const PLAN_CLAIM = /\b(\d+) subscription\s+plans\b/g;

const claims = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => Number(m[1]));

/** Each file and the claims it must carry. A file that drops a claim fails too, so the guard can't go quiet. */
const FILES: { file: string; text: () => string; plans: boolean }[] = [
	{ file: "README.md", text: () => read("README.md"), plans: true },
	{ file: "SKILL.md", text: () => read("SKILL.md"), plans: true },
	{ file: "package.json", text: () => JSON.parse(read("package.json")).description, plans: true },
	{ file: "server.json", text: () => JSON.parse(read("server.json")).description, plans: false },
];

describe("catalog counts in published text", () => {
	it("the catalog has both kinds of entry", () => {
		expect(providers).toBeGreaterThan(0);
		expect(plans).toBeGreaterThan(0);
		expect(providers + plans).toBe(PROVIDER_CATALOG.length);
	});

	for (const { file, text, plans: hasPlans } of FILES) {
		it(`${file} quotes ${providers} providers${hasPlans ? ` and ${plans} plans` : ""}`, () => {
			const body = text();
			const p = claims(body, PROVIDER_CLAIM);
			expect(p.length, `${file} has no provider count`).toBeGreaterThan(0);
			expect(p, `${file} provider count`).toEqual(p.map(() => providers));
			if (hasPlans) {
				const s = claims(body, PLAN_CLAIM);
				expect(s.length, `${file} has no plan count`).toBeGreaterThan(0);
				expect(s, `${file} plan count`).toEqual(s.map(() => plans));
			}
		});
	}
});
