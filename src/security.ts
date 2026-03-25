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

/** Known credential prefixes — each must be followed by enough chars to be a real key. */
const CREDENTIAL_PATTERNS = [
	/\bsk-[A-Za-z0-9]{20,}/,           // OpenAI API keys
	/\bsk-proj-[A-Za-z0-9]{20,}/,      // OpenAI project keys
	/\bAKIA[A-Z0-9]{16}/,              // AWS access key IDs
	/\bghp_[A-Za-z0-9]{36,}/,          // GitHub personal access tokens
	/\bgho_[A-Za-z0-9]{36,}/,          // GitHub OAuth tokens
	/\bghs_[A-Za-z0-9]{36,}/,          // GitHub app installation tokens
	/\bxoxb-[A-Za-z0-9\-]{24,}/,       // Slack bot tokens
	/\bxoxp-[A-Za-z0-9\-]{24,}/,       // Slack user tokens
	/\bAIza[A-Za-z0-9_\-]{30,}/,       // Google API keys
	/\bya29\.[A-Za-z0-9_\-]{50,}/,     // Google OAuth access tokens
	/\bglpat-[A-Za-z0-9\-]{20,}/,      // GitLab personal access tokens
	/\bnpm_[A-Za-z0-9]{36,}/,          // npm tokens
	/\bpypi-[A-Za-z0-9]{50,}/,         // PyPI tokens
	/\bhf_[A-Za-z0-9]{30,}/,           // Hugging Face tokens
	/\bBearer\s+[A-Za-z0-9._\-]{40,}/, // Generic bearer tokens in data
];

/** Script / HTML injection patterns (case-insensitive). */
const SCRIPT_PATTERN = /<script[\s>]/i;
const EVENT_HANDLER_PATTERN = /\bon\w+\s*=\s*["'`]/i;
const JAVASCRIPT_URI_PATTERN = /javascript\s*:/i;

/** Shell injection — command substitution and chaining to exfiltration tools. */
const SHELL_INJECTION_PATTERNS = [
	/\$\([^)]+\)/,                     // $(command)
	/`[^`]{2,}`/,                      // `command` (backtick execution, 2+ chars to avoid markdown)
	/[;|&]\s*(curl|wget|nc|bash|sh|python|node|ruby|perl|php)\b/i, // chain to dangerous commands
];

/** Data URIs that can carry executable content. */
const DATA_URI_PATTERN = /^data:(text\/html|application\/)/i;

/** Null byte in any form. */
const NULL_BYTE_PATTERN = /\x00|\\x00|\\u0000|%00/;

/** Long hex-only blobs (64+ hex chars) — potential obfuscated payloads. */
const HEX_BLOB_PATTERN = /^(0x)?[0-9a-fA-F]{64,}$/;

/** Prototype pollution key — `__proto__` is the only key that directly
 *  triggers pollution on `JSON.parse` output when merged naively.
 *  `constructor` and `prototype` are common legitimate JSON keys and
 *  are intentionally not flagged to avoid false positives. */
const PROTO_POLLUTION_KEY = "__proto__";

/** Maximum reasonable string length for model metadata values. */
const MAX_STRING_LENGTH = 2048;

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
		test: (v) => BASE64_PATTERN.test(v),
	},
];

/** Threats checked against object keys specifically. */
const KEY_THREATS: Threat[] = [
	{
		name: "null_byte",
		test: (v) => NULL_BYTE_PATTERN.test(v),
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
		test: (v) => BASE64_PATTERN.test(v),
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
export function scanPayload(obj: unknown, path = ""): ThreatHit | undefined {
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
			const hit = scanPayload(obj[i], `${path}[${i}]`);
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
			const hit = scanPayload((obj as Record<string, unknown>)[key], `${path}.${key}`);
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

