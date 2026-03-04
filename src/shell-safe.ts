/**
 * Shell safety utilities — input validation for values passed to CLI subprocesses.
 *
 * Prevents command injection by rejecting values that contain shell
 * metacharacters.  Only alphanumeric characters, hyphens, underscores,
 * and dots are allowed.
 * @module
 */

const SAFE_CLI_ARG = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate that a string is safe to pass as a CLI argument.
 *
 * @throws {Error} When the value contains characters outside the safe set.
 */
export function assertSafeShellArg(value: string, label: string): void {
	if (!SAFE_CLI_ARG.test(value)) {
		throw new Error(
			`Unsafe ${label} value: "${value}" — only alphanumeric characters, hyphens, underscores, and dots are allowed`,
		);
	}
}
