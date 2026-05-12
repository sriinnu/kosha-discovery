/**
 * Test hermeticity guard — redirects the process home directory to a per-worker
 * temp dir before test modules import production code.
 *
 * The bug class this prevents: the kosha test suite was silently writing
 * to ~/.kosha/registry.json (instead of a tmpdir) because exportRegistryManifest
 * hardcoded the path. The user's pricing manifest got wiped to 0 models on
 * every test run. Redirecting HOME makes any default cache/manifest writes land
 * in a disposable sandbox, including tests that intentionally exercise default
 * config paths.
 *
 * To intentionally write to ~/.kosha during a test (rare; integration tests
 * that target the user's real install), set TEST_ALLOW_HOME_WRITES=1.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const ALLOW = process.env.TEST_ALLOW_HOME_WRITES === "1";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const testHome = ALLOW ? null : mkdtempSync(join(tmpdir(), "kosha-test-home-"));

if (testHome) {
	process.env.HOME = testHome;
	process.env.USERPROFILE = testHome;
}

afterAll(() => {
	if (!testHome) return;
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	rmSync(testHome, { recursive: true, force: true });
});
