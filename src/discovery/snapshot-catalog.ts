/**
 * kosha-discovery — Last-resort catalog: kosha's own published snapshot.
 *
 * Keyless discovery leans on two community catalogs, models.dev and LiteLLM.
 * If both are unreachable — an outage, a blocked network, or one day a
 * project going away — this loads the weekly snapshot that kosha's own
 * scheduled run publishes as a release asset. It is at most a week old and
 * carries everything the catalogs did: prices, limits, lifecycle.
 *
 * Same discipline as the other catalog loaders: bounded fetch, bounded body,
 * threat scan per provider before any field is read, one in-flight promise
 * so concurrent callers share a fetch, and a reset hook for tests.
 * @module
 */

import { quarantineEntries } from "../security.js";
import type { ModelCard } from "../types.js";

/** The stable URL the snapshot workflow publishes to. */
export const SNAPSHOT_CATALOG_URL =
	"https://github.com/sriinnu/kosha-discovery/releases/download/snapshot-latest/kosha-latest.json";

/** Env override for forks and air-gapped mirrors; must be an https URL. */
export const SNAPSHOT_CATALOG_URL_ENV = "KOSHA_SNAPSHOT_URL";

/** Hard cap on the payload; the snapshot is ~3 MB today. */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** Network timeout for the snapshot fetch. */
const FETCH_TIMEOUT_MS = 15_000;

/** Upper bound on providers in a snapshot — anything larger is not ours. */
const MAX_PROVIDERS = 500;

/** The slice of the snapshot this loader reads. */
interface SnapshotProvider {
	id: string;
	models?: unknown[];
}

let inflight: Promise<Map<string, ModelCard[]>> | null = null;

/** Resolve the snapshot URL, honouring the env override when it is sane. */
export function snapshotCatalogUrl(): string {
	const override = process.env[SNAPSHOT_CATALOG_URL_ENV];
	if (override && /^https:\/\/[^\s]+$/.test(override)) return override;
	return SNAPSHOT_CATALOG_URL;
}

/** Load the snapshot once per process, keyed by provider id. */
export function loadSnapshotCatalog(): Promise<Map<string, ModelCard[]>> {
	if (inflight) return inflight;
	inflight = fetchAndValidate().catch((error) => {
		inflight = null; // let the next caller retry
		throw error;
	});
	return inflight;
}

export function resetSnapshotCatalogCache(): void {
	inflight = null;
}

/**
 * Seed cards for one provider from the snapshot. The cards are already in
 * ModelCard shape; `discoveredAt` is stamped now, and `catalogSource` says
 * where they came from so a consumer can tell a week-old price from a fresh
 * one. Returns `[]` for a provider the snapshot does not carry.
 */
export async function getSnapshotSeed(providerId: string): Promise<ModelCard[]> {
	const catalog = await loadSnapshotCatalog();
	const now = Date.now();
	return (catalog.get(providerId) ?? []).map((card) => ({
		...card,
		discoveredAt: now,
		source: "litellm",
		catalogSource: "snapshot",
	}));
}

async function fetchAndValidate(): Promise<Map<string, ModelCard[]>> {
	const url = snapshotCatalogUrl();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch kosha snapshot: ${response.status} ${response.statusText}`);
	}

	const text = await readBoundedText(response, MAX_PAYLOAD_BYTES);

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Failed to parse kosha snapshot: invalid JSON");
	}
	const providers = (parsed as { providers?: unknown })?.providers;
	if (!Array.isArray(providers)) {
		throw new Error("Failed to parse kosha snapshot: expected a providers array");
	}
	if (providers.length > MAX_PROVIDERS) {
		throw new Error(`kosha snapshot exceeds provider cap (${providers.length} > ${MAX_PROVIDERS}) — refusing to load`);
	}

	// Key by provider id so the threat scan can quarantine one provider's
	// rows without discarding the rest — the same shape the other loaders use.
	const byId: Record<string, unknown> = Object.create(null);
	for (const entry of providers) {
		const provider = entry as SnapshotProvider;
		if (!provider || typeof provider !== "object" || typeof provider.id !== "string") continue;
		byId[provider.id] = Array.isArray(provider.models) ? provider.models : [];
	}
	const { clean } = quarantineEntries(byId, "kosha snapshot");

	const out = new Map<string, ModelCard[]>();
	for (const [id, models] of Object.entries(clean)) {
		if (!Array.isArray(models)) continue;
		const cards = models.filter(isModelCardShape).filter((card) => card.provider === id);
		if (cards.length > 0) out.set(id, cards);
	}
	return out;
}

/** Only the fields every path downstream dereferences; the rest ride along. */
function isModelCardShape(value: unknown): value is ModelCard {
	if (!value || typeof value !== "object") return false;
	const card = value as Partial<ModelCard>;
	return (
		typeof card.id === "string" &&
		typeof card.provider === "string" &&
		typeof card.mode === "string" &&
		Array.isArray(card.capabilities) &&
		typeof card.contextWindow === "number" &&
		typeof card.maxOutputTokens === "number"
	);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (contentLength > maxBytes) {
		throw new Error(`kosha snapshot too large (${contentLength} > ${maxBytes} bytes) — refusing to load`);
	}
	if (!response.body) {
		const text = await response.text();
		if (text.length > maxBytes) {
			throw new Error(`kosha snapshot too large (${text.length} > ${maxBytes} chars) — refusing to load`);
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
			throw new Error(`kosha snapshot too large (> ${maxBytes} bytes) — refusing to load`);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}
