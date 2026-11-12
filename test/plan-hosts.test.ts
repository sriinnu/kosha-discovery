/**
 * MiniMax's plans read the shared MINIMAX_API_KEY, so every MiniMax entry must
 * sit on a MiniMax host. 1.14.0 shipped the China plan on api.minimax.cn while
 * every other MiniMax entry (and MiniMax's docs) used api.minimaxi.com.
 */
import { describe, expect, it } from "vitest";
import { getProviderDescriptor, PROVIDER_CATALOG } from "../src/provider-catalog.js";

const MINIMAX_HOSTS = new Set(["api.minimax.io", "api.minimaxi.com"]);

describe("MiniMax hosts", () => {
	it("every MiniMax entry, plans included, uses api.minimax.io or api.minimaxi.com", () => {
		const entries = PROVIDER_CATALOG.filter((d) => d.providerId.startsWith("minimax"));
		expect(entries.length).toBeGreaterThanOrEqual(4);
		const off = entries
			.filter((d) => !MINIMAX_HOSTS.has(new URL(d.defaultBaseUrl).hostname))
			.map((d) => `${d.providerId} → ${d.defaultBaseUrl}`);
		expect(off).toEqual([]);
	});

	it("puts the China plan on api.minimaxi.com", () => {
		expect(new URL(getProviderDescriptor("minimax-cn-coding-plan")?.defaultBaseUrl ?? "").hostname).toBe(
			"api.minimaxi.com",
		);
	});
});
