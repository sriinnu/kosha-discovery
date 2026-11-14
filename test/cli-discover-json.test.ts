/** `--json` commands must print only JSON to stdout, so `| jq` works. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdDiscover, ensureDiscovered } from "../src/cli-commands.js";
import type { ModelRegistry } from "../src/registry.js";

describe("kosha discover --json", () => {
	afterEach(() => vi.restoreAllMocks());

	it("writes nothing but the JSON to stdout", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const registry = { discover: async () => [], toJSON: () => ({ providers: [] }) } as unknown as ModelRegistry;
		await cmdDiscover(registry, { json: true });
		const out = log.mock.calls.map((call) => call.join(" ")).join("\n");
		expect(JSON.parse(out)).toEqual({ providers: [] });
	});
});

describe("the status line before a query command's output", () => {
	afterEach(() => vi.restoreAllMocks());

	it("goes to stderr, never stdout, for a cache load and a live discovery", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		for (const discoveredAt of [Date.now() - 60 * 60 * 1000, Date.now() + 60_000]) {
			const registry = {
				providers_list: () => [] as unknown[],
				discover: async () => [],
				toJSON: () => ({ discoveredAt }),
			} as unknown as ModelRegistry;
			await ensureDiscovered(registry);
		}
		expect(log).not.toHaveBeenCalled();
		expect(err.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/from cache[\s\S]*Discovered/);
	});
});
