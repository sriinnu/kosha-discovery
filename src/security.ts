/**
 * kosha-discovery — Security guardrails for external data.
 *
 * Centralised defences against supply-chain data injection.
 * Every external data ingestion point (HTTP responses, CLI output,
 * cache reads) MUST pass through {@link assertCleanPayload} before
 * the parsed payload is used.
 *
 * Threat catalogue:
 * - **base64**           Encoded credential exfiltration (LiteLLM incident)
 * - **credential_leak**  Leaked API keys / tokens (OpenAI, AWS, GitHub, Slack, Google, etc.)
 * - **script_injection** XSS / HTML injection via `<script>`, `javascript:`, event handlers
 * - **shell_injection**  Command injection via `$(…)`, backtick blocks, pipe/chain to shells
 * - **data_uri**         Executable data URIs (`data:text/html`, `data:application/…`)
 * - **null_byte**        Null-byte injection to bypass string validators
 * - **proto_pollution**  Prototype pollution via `__proto__` keys
 * - **hex_payload**      Long hex-encoded binary blobs (potential obfuscated payloads)
 * - **oversized_string** Unreasonably long strings for model metadata (>2048 chars)
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Threat: a named pattern check against a single string value.
// ---------------------------------------------------------------------------

interface Threat {
	name: string;
	test: (value: string) => boolean;
}

/** 32+ chars of pure base64 alphabet with optional `=` padding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]{32,}={0,2}$/;
/**
 * Base64 of random binary data draws near-uniformly from a 64-character
 * alphabet, so a 32-character run contains an uppercase letter, a lowercase
 * letter, *and* a digit with overwhelming probability. Human-authored
 * identifiers that happen to live in the base64 alphabet — URL paths,
 * namespaced model IDs, slugs — routinely lack one of the three.
 *
 * Both requirements were added after real false positives:
 *
 *  - Mixed case, for OpenRouter's `links.details =
 *    "/api/v1/models/openrouter/free/endpoints"` — 40 chars of `[A-Za-z0-9/]`,
 *    plainly a URL.
 *  - A digit, for the models.dev key `deepinfra/thinkingmachines/Inkling`
 *    — 33 chars, mixed case, no digit. That single key inside one third-party
 *    aggregator's entry made the scan reject the *entire* 222-provider
 *    catalog, which silently disabled every keyless provider fallback kosha
 *    has. A new model shipping upstream should never be able to do that.
 *
 * Measured cost of requiring a digit (200k samples each): a random 32-byte
 * blob's base64 lacks a digit 0.06% of the time, and a `sk-`-shaped ASCII key
 * never did — 0 in 200,000 — because base64 of ASCII text is digit-dense. So
 * the narrowing gives up essentially nothing against the case that matters,
 * and {@link decodesToThreat} covers the remainder by decoding rather than
 * guessing from shape.
 */
const BASE64_HAS_UPPER = /[A-Z]/;
const BASE64_HAS_LOWER = /[a-z]/;
const BASE64_HAS_DIGIT = /[0-9]/;

/** Longest base64 candidate worth decoding. Bounds the work per value. */
const MAX_DECODE_LENGTH = 8192;

/**
 * True when a base64-alphabet string is genuinely suspicious.
 *
 * Two independent signals, either of which is enough:
 *
 *  1. **Statistical.** Upper, lower *and* digit present — what random binary
 *     data looks like once encoded, and what hand-written identifiers usually
 *     are not.
 *  2. **Semantic.** The string decodes to text that trips a credential,
 *     script, or shell pattern. This is the signal that actually matters: it
 *     catches an encoded secret regardless of how the characters happen to be
 *     distributed, so narrowing (1) to stop rejecting namespaced model IDs
 *     does not narrow what kosha catches. A model path like
 *     `deepinfra/thinkingmachines/Inkling` decodes to binary noise and stays
 *     clean; an encoded `sk-…` key trips (2) even with no digit in sight.
 */
function looksLikeBase64(value: string): boolean {
	if (!BASE64_PATTERN.test(value)) return false;
	if (BASE64_HAS_UPPER.test(value) && BASE64_HAS_LOWER.test(value) && BASE64_HAS_DIGIT.test(value)) {
		return true;
	}
	return decodesToThreat(value);
}

/**
 * Decode a base64 candidate and report whether the plaintext carries a
 * credential, script, or shell payload.
 *
 * Only these three families are re-checked: they are the ones an attacker has
 * a reason to hide behind an encoding. Re-running the whole registry (base64
 * included) would recurse.
 */
function decodesToThreat(value: string): boolean {
	if (value.length > MAX_DECODE_LENGTH) return false;
	let decoded: string;
	try {
		decoded = Buffer.from(value, "base64").toString("utf8");
	} catch {
		return false;
	}
	if (decoded.length === 0) return false;
	return (
		CREDENTIAL_PATTERNS.some((pattern) => pattern.test(decoded)) ||
		SCRIPT_PATTERN.test(decoded) ||
		JAVASCRIPT_URI_PATTERN.test(decoded) ||
		SHELL_INJECTION_PATTERNS.some((pattern) => pattern.test(decoded))
	);
}

/**
 * C0 and C1 control characters plus DEL, excluding tab, newline, and carriage
 * return, which appear legitimately in prose fields.
 *
 * This is the ANSI-injection guard. kosha prints catalog-derived model IDs and
 * names straight to a terminal, so an ESC in an upstream model name is enough
 * to move the cursor, clear the screen, rewrite earlier output, or set the
 * window title — a provider could make `kosha list` display a different model
 * than the one it routes to. Catching it at ingestion covers every print site
 * at once, and the CLI, HTTP API, and MCP server all inherit it.
 */
// Built through `new RegExp` from escape sequences rather than written as a
// literal, matching how NULL_BYTE_PATTERN above is constructed: the ranges are
// resolved by the regex parser, so no control character appears in the source.
const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]");

/**
 * Bidirectional and invisible formatting overrides — the "trojan source"
 * family. These reorder how text renders without changing the bytes, so a
 * model ID can display as one thing and resolve as another. Nothing in a model
 * catalogue needs them.
 */
const BIDI_OVERRIDE_PATTERN = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** Known credential prefixes — each must be followed by enough chars to be a real key. */
const CREDENTIAL_PATTERNS = [
	/\bsk-[A-Za-z0-9]{20,}/,           // OpenAI API keys
	/\bsk-proj-[A-Za-z0-9]{20,}/,      // OpenAI project keys
	/\bAKIA[A-Z0-9]{16}/,              // AWS access key IDs
	/\bghp_[A-Za-z0-9]{36,}/,          // GitHub personal access tokens
	/\bgho_[A-Za-z0-9]{36,}/,          // GitHub OAuth tokens
	/\bghs_[A-Za-z0-9]{36,}/,          // GitHub app installation tokens
	/\bxoxb-[A-Za-z0-9-]{24,}/,        // Slack bot tokens
	/\bxoxp-[A-Za-z0-9-]{24,}/,        // Slack user tokens
	/\bAIza[A-Za-z0-9_-]{30,}/,        // Google API keys
	/\bya29\.[A-Za-z0-9_-]{50,}/,      // Google OAuth access tokens
	/\bglpat-[A-Za-z0-9-]{20,}/,       // GitLab personal access tokens
	/\bnpm_[A-Za-z0-9]{36,}/,          // npm tokens
	/\bpypi-[A-Za-z0-9]{50,}/,         // PyPI tokens
	/\bhf_[A-Za-z0-9]{30,}/,           // Hugging Face tokens
	/\bBearer\s+[A-Za-z0-9._\-]{40,}/, // Generic bearer tokens in data
];

/** Script / HTML injection patterns (case-insensitive). */
const SCRIPT_PATTERN = /<script[\s>]/i;
const EVENT_HANDLER_PATTERN = /\bon\w+\s*=\s*["'`]/i;
const JAVASCRIPT_URI_PATTERN = /javascript\s*:/i;

/**
 * Shell injection — command substitution and chaining to exfiltration tools.
 *
 * The backtick rule has bitten me twice with markdown code spans inside
 * model descriptions (e.g. OpenRouter's `relace-search` describes its
 * own tools as `view_file` and `grep` — purely documentation, not
 * injection). Real shell injection in a backtick block requires either
 * a shell metacharacter (`$`, `;`, `|`, `>`, `<`, `&`) or a dangerous
 * command name. I keep the chain-to-dangerous-command rule below as the
 * primary defence; the backtick rule now only fires on backtick blocks
 * that contain shell metacharacters, so plain `code spans` in docs pass
 * through cleanly.
 */
const SHELL_INJECTION_PATTERNS = [
	/\$\([^)]+\)/,                     // $(command)
	/`[^`\n]*[$;|&<>][^`\n]*`/,        // `…with shell metachar inside…`
	/`[^`\n]*\b(curl|wget|nc|bash|sh|eval|rm|mv|cp|chmod|chown|kill|sudo|ssh|scp)\b[^`\n]*`/i, // backtick-wrapped dangerous command
	/[;|&]\s*(curl|wget|nc|bash|sh|python|node|ruby|perl|php)\b/i, // chain to dangerous commands
];

/** Data URIs that can carry executable content. */
const DATA_URI_PATTERN = /^data:(text\/html|application\/)/i;

/** Null byte in any form. */
const NULL_BYTE_PATTERN = new RegExp(`${String.fromCharCode(0)}|\\\\x00|\\\\u0000|%00`);

/** Long hex-only blobs (64+ hex chars) — potential obfuscated payloads. */
const HEX_BLOB_PATTERN = /^(0x)?[0-9a-fA-F]{64,}$/;

/** Prototype pollution key — `__proto__` is the only key that directly
 *  triggers pollution on `JSON.parse` output when merged naively.
 *  `constructor` and `prototype` are common legitimate JSON keys and
 *  are intentionally not flagged to avoid false positives. */
const PROTO_POLLUTION_KEY = "__proto__";

/** Maximum reasonable string length for model metadata values. */
const MAX_STRING_LENGTH = 2048;

/**
 * Maximum nesting depth accepted in an external payload. The deepest real
 * shape kosha ingests is roughly `provider.models.<id>.cost.batch.input` —
 * six levels. 64 leaves generous headroom while keeping the recursive scan
 * inside its stack budget.
 */
const MAX_SCAN_DEPTH = 64;

// ---------------------------------------------------------------------------
// Threat registry — evaluated once per string value during scan.
// ---------------------------------------------------------------------------

// Ordered most-specific first → broadest last.  This ensures that a leaked
// API key (which is also valid base64) reports "credential_leak" rather than
// the generic "base64" catch-all.
const VALUE_THREATS: Threat[] = [
	{
		name: "null_byte",
		test: (v) => NULL_BYTE_PATTERN.test(v),
	},
	{
		name: "control_chars",
		test: (v) => CONTROL_CHAR_PATTERN.test(v),
	},
	{
		name: "bidi_override",
		test: (v) => BIDI_OVERRIDE_PATTERN.test(v),
	},
	{
		name: "credential_leak",
		test: (v) => CREDENTIAL_PATTERNS.some((p) => p.test(v)),
	},
	{
		name: "script_injection",
		test: (v) => SCRIPT_PATTERN.test(v) || EVENT_HANDLER_PATTERN.test(v) || JAVASCRIPT_URI_PATTERN.test(v),
	},
	{
		name: "shell_injection",
		test: (v) => SHELL_INJECTION_PATTERNS.some((p) => p.test(v)),
	},
	{
		name: "data_uri",
		test: (v) => DATA_URI_PATTERN.test(v),
	},
	{
		name: "oversized_string",
		test: (v) => v.length > MAX_STRING_LENGTH,
	},
	{
		name: "hex_payload",
		test: (v) => HEX_BLOB_PATTERN.test(v),
	},
	{
		name: "base64",
		test: looksLikeBase64,
	},
];

/** Threats checked against object keys specifically. */
const KEY_THREATS: Threat[] = [
	{
		name: "null_byte",
		test: (v) => NULL_BYTE_PATTERN.test(v),
	},
	{
		name: "control_chars",
		test: (v) => CONTROL_CHAR_PATTERN.test(v),
	},
	{
		name: "bidi_override",
		test: (v) => BIDI_OVERRIDE_PATTERN.test(v),
	},
	{
		name: "proto_pollution",
		test: (v) => v === PROTO_POLLUTION_KEY,
	},
	{
		name: "credential_leak",
		test: (v) => CREDENTIAL_PATTERNS.some((p) => p.test(v)),
	},
	{
		name: "base64",
		test: looksLikeBase64,
	},
];

// ---------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------

export interface ThreatHit {
	threat: string;
	path: string;
	value: string;
}

// ---------------------------------------------------------------------------
// Deep scanner
// ---------------------------------------------------------------------------

/**
 * Deep-scan a parsed JSON payload for security threats in keys and string
 * values at any nesting depth.
 *
 * @returns The first {@link ThreatHit} found, or `undefined` if clean.
 */
export function scanPayload(obj: unknown, path = "", depth = 0): ThreatHit | undefined {
	// A payload nested deeper than anything a model catalogue needs is itself
	// the finding: without this, a few megabytes of `[[[[…]]]]` overflows the
	// stack inside the scanner and takes the process down before any field is
	// read. Reported rather than thrown so callers handle it like any threat.
	if (depth > MAX_SCAN_DEPTH) {
		return { threat: "excessive_nesting", path, value: `depth > ${MAX_SCAN_DEPTH}` };
	}
	if (typeof obj === "string") {
		for (const t of VALUE_THREATS) {
			if (t.test(obj)) {
				return { threat: t.name, path, value: obj.length > 80 ? `${obj.slice(0, 80)}…` : obj };
			}
		}
		return undefined;
	}
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			const hit = scanPayload(obj[i], `${path}[${i}]`, depth + 1);
			if (hit) return hit;
		}
		return undefined;
	}
	if (obj !== null && typeof obj === "object") {
		for (const key of Object.keys(obj)) {
			// Check the key itself
			for (const t of KEY_THREATS) {
				if (t.test(key)) {
					return { threat: t.name, path: `${path}.${key}`, value: key };
				}
			}
			// Recurse into the value
			const hit = scanPayload((obj as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
			if (hit) return hit;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Public assertion API
// ---------------------------------------------------------------------------

/**
 * Throw if the given payload contains **any** security threat — base64,
 * leaked credentials, script injection, shell injection, data URIs,
 * null bytes, prototype pollution keys, hex blobs, or oversized strings.
 *
 * @param data   - Parsed JSON payload to scan.
 * @param source - Human-readable label for error messages (e.g. "litellm", "OpenAI API").
 * @throws {Error} with the threat name and offending path.
 */
export function assertCleanPayload(data: unknown, source: string): void {
	const hit = scanPayload(data);
	if (hit) {
		throw new Error(
			`Rejected ${source} data: ${hit.threat} detected at "${hit.path}" — refusing to load potentially compromised payload`,
		);
	}
}

// ---------------------------------------------------------------------------
// Per-entry quarantine for large community catalogs
// ---------------------------------------------------------------------------

/** One entry dropped by {@link quarantineEntries}. */
export interface QuarantinedEntry {
	/** Top-level key that was dropped. */
	key: string;
	/** Threat name that tripped. */
	threat: string;
	/** Path of the offending value inside the dropped entry. */
	path: string;
}

/** Outcome of a per-entry quarantine pass. */
export interface QuarantineResult {
	/** Entries that scanned clean. */
	clean: Record<string, unknown>;
	/** Entries that were dropped, with the reason. */
	dropped: QuarantinedEntry[];
}

/**
 * Fraction of entries that may be dropped before the whole feed is treated as
 * compromised. A handful of odd rows in a community catalog is normal; most of
 * the feed tripping the scanner is not.
 */
const MAX_QUARANTINE_RATIO = 0.5;

/**
 * Scan a keyed catalog entry-by-entry, dropping the entries that trip a threat
 * instead of rejecting the whole payload.
 *
 * {@link assertCleanPayload} is the right call for a payload kosha depends on
 * in full — a provider's own `/v1/models` response, a cache file it wrote. It
 * is the wrong call for the big third-party catalogs (models.dev, LiteLLM),
 * where one unusual model name from any of 200+ contributors would otherwise
 * take out every keyless fallback at once. Here, the bad entry is dropped and
 * named, and the rest of the catalog still loads.
 *
 * A feed where more than {@link MAX_QUARANTINE_RATIO} of entries trip is not
 * one bad row — that still throws.
 *
 * @throws {Error} when the payload is not a plain object, or when too much of
 *                 it is unclean to be a localized problem.
 */
export function quarantineEntries(data: unknown, source: string): QuarantineResult {
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`Rejected ${source} data: expected an object of entries`);
	}

	const clean: Record<string, unknown> = Object.create(null);
	const dropped: QuarantinedEntry[] = [];

	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		// A poisoned key is not quarantinable — `__proto__` and null bytes are
		// structural attacks on the object itself, so the feed is rejected.
		for (const threat of KEY_THREATS) {
			if (threat.test(key)) {
				throw new Error(
					`Rejected ${source} data: ${threat.name} detected in top-level key "${key}" — refusing to load potentially compromised payload`,
				);
			}
		}

		const hit = scanPayload(value, `.${key}`, 1);
		if (hit) {
			dropped.push({ key, threat: hit.threat, path: hit.path });
			continue;
		}
		clean[key] = value;
	}

	const total = dropped.length + Object.keys(clean).length;
	if (total > 0 && dropped.length / total > MAX_QUARANTINE_RATIO) {
		throw new Error(
			`Rejected ${source} data: ${dropped.length} of ${total} entries tripped the threat scan (${dropped[0]?.threat} at "${dropped[0]?.path}") — refusing to load a feed this unclean`,
		);
	}

	return { clean, dropped };
}
