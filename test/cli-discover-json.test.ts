/** `kosha discover --json` must print only JSON, so `| jq` works. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdDiscover } from "../src/cli-commands.js";
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
