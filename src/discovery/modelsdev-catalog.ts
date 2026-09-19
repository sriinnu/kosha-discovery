/**
 * kosha-discovery — Shared models.dev catalog loader.
 *
 * Pulls the keyless community catalog at https://models.dev/api.json,
 * which is maintained by the SST team and tends to surface new models
 * faster than LiteLLM. Same hardening contract as the LiteLLM loader:
 * HTTPS-pinned URL, per-provider threat quarantine, bounded body read,
 * entry-count cap, promise-deduped singleton.
 *
 * Schema (top level):
 *   {
 *     [providerSlug]: {
 *       id, name, env: string[], doc, npm, api,
 *       models: {
 *         [modelId]: {
 *           id, name, family,
 *           attachment, reasoning, tool_call, structured_output, temperature,
 *           knowledge, release_date, last_updated,
 *           modalities: { input: string[], output: string[] },
 *           open_weights,
 *           cost: { input, output, cache_read?, cache_write?, ... },
 *           limit: { context, output, input? }
 *         }
 *       }
 *     }
 *   }
 * @module
 */

import { type QuarantinedEntry, quarantineEntries } from "../security.js";

/** Pinned upstream catalog URL — HTTPS only. */
export const MODELSDEV_CATALOG_URL = "https://models.dev/api.json";

/** Maximum response payload size (8 MB) — current catalog is ~600 KB. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Maximum top-level provider entry count we accept. */
const MAX_PROVIDER_ENTRIES = 1_000;

/** Network timeout for the catalog fetch. */
const FETCH_TIMEOUT_MS = 15_000;

/** Cost block for a single model entry. Fields are optional / forward-compatible. */
export interface ModelsDevCost {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
	/** Per-million tokens for >200K-context billing tier (OpenAI long-context tier). */
	context_over_200k?: { input?: number; output?: number; cache_read?: number };
	/** Per-million tokens for batch API tier. */
	batch?: { input?: number; output?: number };
}

/** Limit block — context window + output cap + optional input cap. */
export interface ModelsDevLimit {
	context?: number;
	output?: number;
	input?: number;
}

/** Modalities block — structured input/output media kinds. */
export interface ModelsDevModalities {
	input?: string[];
	output?: string[];
}

/** A single model entry in models.dev. */
export interface ModelsDevModel {
	id: string;
	name?: string;
	family?: string;
	attachment?: boolean;
	reasoning?: boolean;
	tool_call?: boolean;
	structured_output?: boolean;
	temperature?: boolean;
	knowledge?: string;
	release_date?: string;
	last_updated?: string;
	modalities?: ModelsDevModalities;
	open_weights?: boolean;
	cost?: ModelsDevCost;
	limit?: ModelsDevLimit;
}

/** A single provider entry in models.dev. */
export interface ModelsDevProvider {
	id: string;
	name?: string;
	env?: string[];
	api?: string;
	doc?: string;
	npm?: string;
	models?: Record<string, ModelsDevModel>;
}

/** Module-level promise-dedup cache. */
let inflight: Promise<Record<string, ModelsDevProvider>> | null = null;

/** Provider entries dropped by the threat scan on the most recent load. */
let lastQuarantined: QuarantinedEntry[] = [];

/**
 * Provider entries the threat scan dropped from the last successful load.
 *
 * Surfaced so `kosha doctor` can report a quarantined provider instead of it
 * just going quietly missing from the catalog.
 */
export function modelsDevQuarantined(): QuarantinedEntry[] {
	return [...lastQuarantined];
}

/**
 * Fetch the models.dev catalog with full hardening. Concurrent callers
 * share the same in-flight promise.
 */
export function loadModelsDevCatalog(): Promise<Record<string, ModelsDevProvider>> {
	if (inflight) return inflight;
	inflight = fetchAndValidate().catch((error) => {
		// Reset on failure so future calls can retry.
		inflight = null;
		throw error;
	});
	return inflight;
}

/** Test-only helper to clear the cache between runs. */
export function resetModelsDevCatalogCache(): void {
	inflight = null;
	lastQuarantined = [];
}

async function fetchAndValidate(): Promise<Record<string, ModelsDevProvider>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(MODELSDEV_CATALOG_URL, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		throw new Error(
			`Failed to fetch models.dev catalog: ${response.status} ${response.statusText}`,
		);
	}

	const text = await readBoundedText(response, MAX_PAYLOAD_BYTES);

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Failed to parse models.dev catalog: invalid JSON");
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Failed to parse models.dev catalog: expected an object");
	}

	// Quarantine per provider rather than rejecting the catalog. models.dev
	// aggregates 200+ contributors, so one contributor's odd model name must not
	// be able to take out every other provider's entry — which is exactly what
	// an all-or-nothing scan did.
	const { clean, dropped } = quarantineEntries(parsed, "models.dev");
	if (dropped.length > 0) {
		lastQuarantined = dropped;
	}

	const entries = Object.entries(clean);
	if (entries.length > MAX_PROVIDER_ENTRIES) {
		throw new Error(
			`models.dev catalog exceeds provider cap (${entries.length} > ${MAX_PROVIDER_ENTRIES}) — refusing to load`,
		);
	}

	const out: Record<string, ModelsDevProvider> = Object.create(null);
	for (const [key, value] of entries) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			out[key] = value as ModelsDevProvider;
		}
	}
	return out;
}

/** Stream-read a Response body but cap total bytes received. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (contentLength > maxBytes) {
		throw new Error(
			`models.dev catalog too large (${contentLength} > ${maxBytes} bytes) — refusing to load`,
		);
	}

	if (!response.body) {
		const text = await response.text();
		if (text.length > maxBytes) {
			throw new Error(
				`models.dev catalog too large (${text.length} > ${maxBytes} chars) — refusing to load`,
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
				/* swallow */
			}
			throw new Error(
				`models.dev catalog too large (>${maxBytes} bytes) — refusing to load`,
			);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}
