/**
 * cli-format.ts — ANSI color helpers, number/token formatting, and table rendering.
 *
 * This module is consumed by `cli-commands.ts` and provides every
 * presentation-layer utility the CLI needs.  It has **zero** side-effects
 * (no I/O, no process manipulation) so it is safe to import anywhere.
 *
 * @module cli-format
 */

// ---------------------------------------------------------------------------
//  ANSI escape-code constants
//
//  Each constant holds a raw ANSI SGR sequence.  They are intentionally
//  exported so that command modules can compose ad-hoc styled strings
//  without pulling in a third-party chalk-like dependency.
//
//  Respect the `NO_COLOR` environment variable (https://no-color.org/).
// ---------------------------------------------------------------------------

/** Whether colour output is globally suppressed via the `NO_COLOR` env var. */
export const NO_COLOR = !!process.env.NO_COLOR;

/** ANSI SGR — bold text. */
export const BOLD = "\x1b[1m";

/** ANSI SGR — dim / faint text. */
export const DIM = "\x1b[2m";

/** ANSI SGR — reset all attributes. */
export const RESET = "\x1b[0m";

/** ANSI SGR — green foreground. */
export const GREEN = "\x1b[32m";

/** ANSI SGR — red foreground. */
export const RED = "\x1b[31m";

/** ANSI SGR — yellow foreground. */
export const YELLOW = "\x1b[33m";

/** ANSI SGR — cyan foreground. */
export const CYAN = "\x1b[36m";

// ---------------------------------------------------------------------------
//  Colour helper
// ---------------------------------------------------------------------------

/**
 * Wrap `text` with the given ANSI `code` and a trailing RESET.
 *
 * When the `NO_COLOR` environment variable is set the original text is
 * returned unmodified, ensuring accessible output in minimal terminals.
 *
 * @param code  An ANSI SGR escape sequence (e.g. `BOLD`, `GREEN`).
 * @param text  The plain-text string to be coloured.
 * @returns     The styled string, or the original string if colour is off.
 */
export function c(code: string, text: string): string {
	return NO_COLOR ? text : code + text + RESET;
}

// ---------------------------------------------------------------------------
//  Numeric / token-count formatters
// ---------------------------------------------------------------------------

/**
 * Format a context-window token count into a human-readable short form.
 *
 * - Values >= 1 000 000 are rendered as e.g. `1M` or `1.5M`.
 * - Values >= 1 000 are rendered as e.g. `128K`.
 * - Zero or falsy values produce an em-dash (`—`).
 *
 * @param tokens  The raw token count.
 * @returns       A compact string representation.
 */
export function formatContextWindow(tokens: number): string {
	if (!tokens || tokens === 0) return "\u2014";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}K`;
	return String(tokens);
}

/**
 * Format a per-million-token price for display.
 *
 * - `undefined` / `null` → em-dash (`—`).
 * - `0` → the literal string `"free"`.
 * - Anything else → e.g. `"$3.00"`.
 *
 * @param price  The dollar price per million tokens, or `undefined`.
 * @returns      A display-ready string.
 */
export function formatPrice(price: number | undefined): string {
	if (price === undefined || price === null) return "\u2014";
	if (price === 0) return "free";
	return `$${price.toFixed(2)}`;
}

/**
 * Format an integer with locale-aware thousand separators.
 *
 * @param n  The number to format.
 * @returns  e.g. `"1,000,000"` for `1000000`.
 */
export function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

/**
 * Convert a Unix-epoch millisecond timestamp to an ISO-8601 string.
 *
 * @param ts  Epoch timestamp in milliseconds.
 * @returns   An ISO-8601 date-time string.
 */
export function formatTimestamp(ts: number): string {
	return new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
//  String-padding helpers
// ---------------------------------------------------------------------------

/**
 * Right-pad `str` to `len` visible characters.
 *
 * ANSI escape sequences are stripped before measuring so that styled
 * strings are padded to the correct *visual* width.
 *
 * @param str  The (possibly ANSI-styled) string.
 * @param len  Desired visible width.
 * @returns    The padded string.
 */
export function padRight(str: string, len: number): string {
	// Strip ANSI codes for length calculation
	const plainLen = str.replace(/\x1b\[[0-9;]*m/g, "").length;
	if (plainLen >= len) return str;
	return str + " ".repeat(len - plainLen);
}

/**
 * Repeat a single character `len` times to produce a horizontal rule.
 *
 * @param char  The character to repeat (e.g. `"─"`).
 * @param len   How many times to repeat it.
 * @returns     A string of length `len`.
 */
export function line(char: string, len: number): string {
	return char.repeat(len);
}

// ---------------------------------------------------------------------------
//  Table renderer
// ---------------------------------------------------------------------------

/**
 * Describes a single column in a CLI table rendered by {@link renderTable}.
 */
export interface Column {
	/** Column heading text. */
	header: string;
	/** Fixed visible width in characters. */
	width: number;
	/** Text alignment — defaults to `"left"`. */
	align?: "left" | "right";
}

/**
 * Render a fixed-width ASCII table string from column definitions and row data.
 *
 * The table consists of three sections:
 * 1. A **bold header** row.
 * 2. A dim `─` separator line.
 * 3. Data rows with each cell padded / aligned according to its column spec.
 *
 * @param columns  Ordered column definitions.
 * @param rows     An array of rows, where each row is an array of cell strings
 *                 whose indices correspond to `columns`.
 * @returns        The fully-rendered table as a single multi-line string.
 */
export function renderTable(columns: Column[], rows: string[][]): string {
	const lines: string[] = [];

	// Header row — bold, aligned per column spec
	const headerParts = columns.map((col) =>
		col.align === "right" ? col.header.padStart(col.width) : padRight(c(BOLD, col.header), col.width),
	);
	lines.push(headerParts.join(" "));

	// Separator row — dim horizontal rules matching each column width
	const sepParts = columns.map((col) => line("\u2500", col.width));
	lines.push(c(DIM, sepParts.join(" ")));

	// Data rows
	for (const row of rows) {
		const parts = columns.map((col, i) => {
			const cell = row[i] ?? "";
			return col.align === "right" ? cell.padStart(col.width) : padRight(cell, col.width);
		});
		lines.push(parts.join(" "));
	}

	return lines.join("\n");
}
