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

// Provider keys exported in a developer's shell would let a test that forgot
// to stub discovery call a real provider with a real key (seen once in 1.14.0).
// Tests that need a key set their own fake one after this runs.
const CREDENTIAL_VAR =
	/(_API_KEY|_API_TOKEN|_ACCESS_TOKEN|_SECRET_ACCESS_KEY|_SESSION_TOKEN|_AUTH_TOKEN)$|^(GOOGLE_APPLICATION_CREDENTIALS|AWS_PROFILE|KOSHA_MONTHLY_BUDGET_USD|KOSHA_TENANT_BUDGET_USD|KOSHA_PROXY_TOKEN)$/;
for (const name of Object.keys(process.env)) {
	if (CREDENTIAL_VAR.test(name)) delete process.env[name];
}

// No test may reach the network. Loopback stays open for the in-process
// servers tests start; everything else fails like an offline machine. A test
// that stubs fetch (vi.stubGlobal / vi.spyOn) replaces this for its own scope.
// Set TEST_ALLOW_NETWORK=1 to run against the real network on purpose.
if (process.env.TEST_ALLOW_NETWORK !== "1") {
	const realFetch = globalThis.fetch;
	const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
	globalThis.fetch = async function hermeticFetch(input: string | URL | Request, init?: RequestInit) {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		let host = "";
		try {
			host = new URL(raw).hostname;
		} catch {
			// Relative or malformed URLs fall through to the real fetch, which rejects them.
		}
		if (LOOPBACK.has(host)) return realFetch(input, init);
		throw new TypeError(`fetch failed (test hermeticity: network blocked for ${host || raw})`);
	} as typeof fetch;
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
