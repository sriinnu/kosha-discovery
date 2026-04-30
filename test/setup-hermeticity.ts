/**
 * Test hermeticity guard — snapshots `~/.kosha` before the test run and
 * re-checks after. If any file inside changed, fail loudly.
 *
 * The bug class this prevents: the kosha test suite was silently writing
 * to ~/.kosha/registry.json (instead of a tmpdir) because exportRegistryManifest
 * hardcoded the path. The user's pricing manifest got wiped to 0 models on
 * every test run. cacheDir-respecting paths now exist, but it's easy to
 * regress — this guard makes any future regression fail CI immediately
 * instead of silently corrupting the user's home dir.
 *
 * To intentionally write to ~/.kosha during a test (rare; integration tests
 * that target the user's real install), set TEST_ALLOW_HOME_WRITES=1.
 *
 * NOTE: ESM-imported fs functions can't be monkey-patched (read-only
 * property bindings), so we snapshot mtimes around the suite instead.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

const HOME_KOSHA = join(homedir(), ".kosha");
const ALLOW = process.env.TEST_ALLOW_HOME_WRITES === "1";

interface FileSnapshot {
	mtimeMs: number;
	size: number;
}

let baseline: Map<string, FileSnapshot> | null = null;

function snapshotDir(root: string): Map<string, FileSnapshot> {
	const out = new Map<string, FileSnapshot>();
	if (!existsSync(root)) return out;
	const stack: string[] = [root];
	while (stack.length) {
		const dir = stack.pop();
		if (!dir) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const p = join(dir, name);
			try {
				const s = statSync(p);
				if (s.isDirectory()) stack.push(p);
				else out.set(p, { mtimeMs: s.mtimeMs, size: s.size });
			} catch {
				// raced with another process — skip
			}
		}
	}
	return out;
}

beforeAll(() => {
	if (ALLOW) return;
	baseline = snapshotDir(HOME_KOSHA);
});

afterAll(() => {
	if (ALLOW || !baseline) return;
	const after = snapshotDir(HOME_KOSHA);
	const changed: string[] = [];
	for (const [path, snap] of after) {
		const before = baseline.get(path);
		if (!before || before.mtimeMs !== snap.mtimeMs || before.size !== snap.size) {
			changed.push(path);
		}
	}
	for (const path of baseline.keys()) {
		if (!after.has(path)) changed.push(`${path} (deleted)`);
	}
	if (changed.length > 0) {
		throw new Error(
			`[hermeticity] tests modified the user's real ${HOME_KOSHA}:\n` +
				changed.map((p) => `  - ${p}`).join("\n") +
				"\n\nPin cacheDir to a tmpdir, or set TEST_ALLOW_HOME_WRITES=1 if intentional.",
		);
	}
});
