import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 10_000,
		// Hermeticity guard — patches fs/promises to throw if any test tries
		// to write inside the user's real ~/.kosha directory. Prevents the
		// class of bug where tests silently corrupt the user's manifest.
		setupFiles: ["./test/setup-hermeticity.ts"],
	},
});
