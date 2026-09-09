/**
 * kosha-mcp over real stdio: entry-point detection, newline-delimited
 * JSON-RPC, and answering before exiting on stdin EOF. Uses the compiled
 * dist/ (built by `pnpm run check` ahead of the test step); skipped when it
 * is absent so `vitest` alone still passes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const entry = new URL("../dist/mcp-server.js", import.meta.url).pathname;

describe.skipIf(!existsSync(entry))("kosha-mcp stdio", () => {
	it("answers initialize, ping and tools/list from a piped one-shot client, then exits 0", async () => {
		const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf-8").on("data", (d: string) => {
			stdout += d;
		});
		child.stderr.setEncoding("utf-8").on("data", (d: string) => {
			stderr += d;
		});
		child.stdin.write(
			[
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 2, method: "ping" },
				{ jsonrpc: "2.0", id: 3, method: "tools/list" },
			]
				.map((m) => JSON.stringify(m))
				.join("\n") + "\n",
		);
		child.stdin.end();
		const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
		expect(code).toBe(0);
		expect(stderr).toBe("");
		const lines = stdout.trim().split("\n").map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
		expect(lines.map((l) => l.id)).toEqual([1, 2, 3]);
		expect((lines[0].result.serverInfo as { name: string }).name).toBe("kosha");
		expect(lines[1].result).toEqual({});
		expect((lines[2].result.tools as unknown[]).length).toBeGreaterThan(5);
	}, 20_000);
});
