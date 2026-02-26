#!/usr/bin/env node
/**
 * cli.ts — Entry point for the kosha CLI.
 *
 * This module is intentionally minimal: it parses raw `process.argv`,
 * routes to the appropriate command handler in `./cli-commands.js`, and
 * handles top-level errors.
 *
 * TypeScript 5.7+ preserves the shebang comment in compiled output, so
 * the built `.js` file can be executed directly as `./cli.js` on Unix.
 *
 * @module cli
 */

import { ModelRegistry } from "./registry.js";
import { DIM, RED, c } from "./cli-format.js";
import {
	cmdDiscover,
	cmdList,
	cmdModel,
	cmdProviders,
	cmdRefresh,
	cmdResolve,
	cmdSearch,
	cmdServe,
	showHelp,
	showVersion,
} from "./cli-commands.js";

// ---------------------------------------------------------------------------
//  Argument parsing
// ---------------------------------------------------------------------------

/**
 * The result of parsing raw CLI arguments.
 *
 * `positional` holds bare tokens (sub-command name, query strings, etc.)
 * while `flags` holds `--key` / `--key value` pairs.
 */
interface ParsedArgs {
	/** Non-flag tokens in the order they appeared (e.g. `["search", "gpt"]`). */
	positional: string[];
	/** Flag map — boolean for bare flags, string when a value follows. */
	flags: Record<string, string | boolean>;
}

/**
 * Parse a raw argv slice into positional tokens and named flags.
 *
 * Flags are identified by the `--` prefix.  If the token immediately
 * following a flag does **not** start with `--`, it is consumed as the
 * flag's value; otherwise the flag is treated as a boolean `true`.
 *
 * @param argv  The argument array, typically `process.argv.slice(2)`.
 * @returns     A {@link ParsedArgs} object.
 */
function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			// If the next token exists and is not itself a flag, treat it as
			// the value for this flag; otherwise mark the flag as boolean true.
			if (next && !next.startsWith("--")) {
				flags[key] = next;
				i += 2;
			} else {
				flags[key] = true;
				i += 1;
			}
		} else {
			positional.push(arg);
			i += 1;
		}
	}

	return { positional, flags };
}

// ---------------------------------------------------------------------------
//  Main entry point
// ---------------------------------------------------------------------------

/**
 * Top-level CLI dispatcher.
 *
 * Parses arguments, checks for global flags (`--help`, `--version`),
 * then routes to the matching command handler.  Commands that need the
 * registry create a shared {@link ModelRegistry} instance.
 */
async function main(): Promise<void> {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const command = positional[0];

	// Global flags — handled before any command
	if (flags.help || command === "help") {
		showHelp();
		return;
	}

	if (flags.version) {
		showVersion();
		return;
	}

	if (!command) {
		showHelp();
		return;
	}

	// The serve command does not need the registry pre-loaded
	if (command === "serve") {
		await cmdServe(flags);
		return;
	}

	// All remaining commands operate on a shared registry instance
	const registry = new ModelRegistry();

	switch (command) {
		case "discover":
			await cmdDiscover(registry, flags);
			break;

		case "list":
		case "ls":
			await cmdList(registry, flags);
			break;

		case "search":
		case "find":
			await cmdSearch(registry, positional[1] ?? "", flags);
			break;

		case "model":
		case "info":
		case "show":
			await cmdModel(registry, positional[1] ?? "", flags);
			break;

		case "providers":
			await cmdProviders(registry, flags);
			break;

		case "resolve":
			await cmdResolve(registry, positional[1] ?? "", flags);
			break;

		case "refresh":
			await cmdRefresh(registry, flags);
			break;

		default:
			console.error(c(RED, `Unknown command: "${command}"`));
			console.error(c(DIM, 'Run "kosha --help" for usage information.'));
			process.exit(1);
	}
}

// Kick off and handle unhandled rejections with a clean error message
main().catch((err) => {
	console.error(c(RED, `Error: ${err.message}`));
	process.exit(1);
});
