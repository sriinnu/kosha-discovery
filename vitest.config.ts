import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 10_000,
		// Hermeticity guard — redirects HOME to a temp dir before tests import
		// production code, so default ~/.kosha paths never touch the real user home.
		setupFiles: ["./test/setup-hermeticity.ts"],
	},
});
