/**
 * Shell safety utilities — input validation for values passed to CLI subprocesses.
 *
 * Prevents command injection by rejecting values that contain shell
 * metacharacters.  Only alphanumeric characters, hyphens, underscores,
 * and dots are allowed.
 * @module
 */

import { homedir } from "node:os";

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

/**
 * Spawn options for the cloud CLIs kosha runs (`gcloud`, `aws`).
 *
 * On Windows, cmd.exe looks for a bare command name in the working directory
 * before PATH. Run from inside a cloned repo, a planted `gcloud.cmd` would
 * execute with every provider key in its environment. The child therefore
 * starts in the home directory, and with `NoDefaultCurrentDirectoryInExePath`
 * set, which turns that lookup off for cmd.exe.
 */
export function cliSpawnOptions(): { cwd: string; env: NodeJS.ProcessEnv } {
	const env = process.platform === "win32" ? { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" } : process.env;
	return { cwd: homedir(), env };
}
