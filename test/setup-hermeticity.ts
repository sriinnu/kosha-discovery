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
	// KOSHA_LEDGER_PATH exported in a developer's shell would point the spend
	// ledger past the sandboxed HOME, at their real file.
	delete process.env.KOSHA_LEDGER_PATH;
}

afterAll(async () => {
	if (!testHome) return;
	// Proxy tests return before their spend row is written. Let those writes
	// land (or fail, and log) while the worker is still alive, instead of
	// racing the delete below.
	await new Promise((resolve) => setTimeout(resolve, 100));
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
	// A fire-and-forget cache or ledger write can still be landing files in
	// the home while this runs; without retries that raced into ENOTEMPTY and
	// failed whichever test file happened to finish last.
	rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
