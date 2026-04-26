/**
 * kosha-discovery — Shared LiteLLM catalog loader.
 *
 * Single source of truth for the community-maintained LiteLLM model catalog
 * used by both the discovery seed (origin providers without an API key) and
 * the post-discovery pricing enricher.
 *
 * Hardening:
 *  - HTTPS-only, fixed source URL — no caller-supplied URLs.
 *  - Promise-deduplicated singleton load — concurrent callers share one fetch.
 *  - AbortController-bounded fetch with explicit timeout.
 *  - Response size cap before parsing to prevent memory bombs.
 *  - {@link assertCleanPayload} runs before any field is read.
 *  - Entry-count cap after parse to bound downstream work.
 *
 * The catalog source is the same one already trusted by the existing
 * enricher; this module just centralises the load.
 * @module
 */

import { assertCleanPayload } from "../security.js";

/** Pinned upstream catalog URL — HTTPS only, no user override. */
export const LITELLM_CATALOG_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Maximum response payload size in bytes (8 MB) — current catalog is ~3 MB. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Maximum entry count in the parsed catalog before we refuse it. */
const MAX_ENTRIES = 25_000;

/** Network timeout for the catalog fetch. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Shape of a single entry in the LiteLLM pricing JSON.
 * Fields are all optional because the upstream schema evolves over time;
 * consumers must defensively handle missing fields.
 */
export interface LiteLLMModelEntry {
	max_tokens?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	input_cost_per_reasoning_token?: number;
	output_cost_per_reasoning_token?: number;
	reasoning_input_cost_per_token?: number;
	reasoning_output_cost_per_token?: number;
	cache_read_input_token_cost?: number;
	cache_creation_input_token_cost?: number;
	input_cost_per_token_batches?: number;
	output_cost_per_token_batches?: number;
	litellm_provider?: string;
	mode?: string;
	supports_function_calling?: boolean;
	supports_vision?: boolean;
	supports_prompt_caching?: boolean;
	supports_response_schema?: boolean;
	supports_tool_choice?: boolean;
	output_vector_size?: number;
}

/** Module-level promise-dedup cache so concurrent callers share one fetch. */
let inflight: Promise<Record<string, LiteLLMModelEntry>> | null = null;

/**
 * Fetch the LiteLLM catalog with full hardening, returning a defensively
 * filtered map. Concurrent callers share the same in-flight promise.
 */
export function loadLiteLLMCatalog(): Promise<Record<string, LiteLLMModelEntry>> {
	if (inflight) return inflight;
	inflight = fetchAndValidate().catch((error) => {
		// Reset on failure so a future call can retry instead of memoising the error.
		inflight = null;
		throw error;
	});
	return inflight;
}

/**
 * Reset the cached catalog. Test-only helper — callers in production code
 * should rely on the process-lifetime cache.
 */
export function resetLiteLLMCatalogCache(): void {
	inflight = null;
}

async function fetchAndValidate(): Promise<Record<string, LiteLLMModelEntry>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(LITELLM_CATALOG_URL, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		throw new Error(
			`Failed to fetch litellm data: ${response.status} ${response.statusText}`,
		);
	}

	const text = await readBoundedText(response, MAX_PAYLOAD_BYTES);

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Failed to parse litellm data: invalid JSON");
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Failed to parse litellm data: expected an object");
	}

	assertCleanPayload(parsed, "litellm");

	const entries = Object.entries(parsed as Record<string, unknown>);
	if (entries.length > MAX_ENTRIES) {
		throw new Error(
			`LiteLLM catalog exceeds entry cap (${entries.length} > ${MAX_ENTRIES}) — refusing to load`,
		);
	}

	const out: Record<string, LiteLLMModelEntry> = Object.create(null);
	for (const [key, value] of entries) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			out[key] = value as LiteLLMModelEntry;
		}
	}
	return out;
}

/**
 * Read a Response body as text but reject if the body exceeds maxBytes.
 * Streams the body chunk-by-chunk so we never buffer more than the cap.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (contentLength > maxBytes) {
		throw new Error(
			`LiteLLM catalog too large (${contentLength} > ${maxBytes} bytes) — refusing to load`,
		);
	}

	if (!response.body) {
		// No streaming body available — fall back to text() but enforce cap on result.
		const text = await response.text();
		if (text.length > maxBytes) {
			throw new Error(
				`LiteLLM catalog too large (${text.length} > ${maxBytes} chars) — refusing to load`,
			);
		}
		return text;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let received = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			try {
				await reader.cancel();
			} catch {
				/* swallow cancel errors; we are already failing */
			}
			throw new Error(
				`LiteLLM catalog too large (>${maxBytes} bytes) — refusing to load`,
			);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}
