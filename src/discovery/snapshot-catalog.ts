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

import { createPublicKey, verify } from "node:crypto";
import { quarantineEntries } from "../security.js";
import type { ModelCard } from "../types.js";

/** The stable URL the snapshot workflow publishes to. */
export const SNAPSHOT_CATALOG_URL =
	"https://github.com/sriinnu/kosha-discovery/releases/download/snapshot-latest/kosha-latest.json";

/** Env override for forks and air-gapped mirrors; must be an https URL. */
export const SNAPSHOT_CATALOG_URL_ENV = "KOSHA_SNAPSHOT_URL";

/**
 * The Ed25519 keys the snapshot workflow signs with (SPKI PEM). A snapshot from
 * the default URL must carry a valid signature by one of them in
 * `kosha-latest.json.sig`, or it is refused. More than one is listed only
 * while a key is being rotated.
 */
export const SNAPSHOT_PUBLIC_KEYS: readonly string[] = [
	"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/nM7HYtoUrh+Uwz7VEOvcSKpvqlwHnsuv/79ZeG3sR0=\n-----END PUBLIC KEY-----\n",
];

/** A mirror's own public key (SPKI PEM). When set, every snapshot URL,
 *  the default included, must be signed by it. */
export const SNAPSHOT_PUBLIC_KEY_ENV = "KOSHA_SNAPSHOT_PUBKEY";

/** Cap on the detached signature file (base64 of 64 bytes, plus slack). */
const MAX_SIGNATURE_BYTES = 1024;

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

/** A parsed catalog: cards keyed by provider id, plus when it was built. */
export interface SnapshotCatalog {
	providers: Map<string, ModelCard[]>;
	/** The envelope's `fetchedAt`, or null when the file does not say. */
	fetchedAt: string | null;
}

let inflight: Promise<SnapshotCatalog> | null = null;

/** Hold bookkeeping the snapshot gate (`src/snapshot-gate.ts`) leaves on a
 *  published card so next week's run can continue it. */
const GATE_FIELDS = ["pricingHold", "priceAnchor", "lastSeenAt", "missingRunCount"] as const;

function withoutGateFields(card: ModelCard): ModelCard {
	if (!GATE_FIELDS.some((field) => field in card)) return card;
	const out = { ...card } as Record<string, unknown>;
	for (const field of GATE_FIELDS) delete out[field];
	return out as unknown as ModelCard;
}

/** Resolve the snapshot URL, honouring the env override when it is sane. */
export function snapshotCatalogUrl(): string {
	const override = process.env[SNAPSHOT_CATALOG_URL_ENV];
	if (override && /^https:\/\/[^\s]+$/.test(override)) return override;
	return SNAPSHOT_CATALOG_URL;
}

/** Load the snapshot once per process, keyed by provider id. */
export function loadSnapshotCatalog(): Promise<SnapshotCatalog> {
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
	// The gate's hold bookkeeping is the publisher's state, not the reader's:
	// a local merge keeps its own clock.
	return (catalog.providers.get(providerId) ?? []).map((card) => ({
		...withoutGateFields(card),
		discoveredAt: now,
		source: "litellm",
		catalogSource: "snapshot",
	}));
}

async function fetchAndValidate(): Promise<SnapshotCatalog> {
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
	const keys = snapshotTrustedKeys(url);
	if (keys) await verifySnapshotSignature(url, text, keys);
	return parseSnapshotCatalog(text, "kosha snapshot");
}

/**
 * The keys a snapshot from `url` must be signed by, or null when it needs
 * none: a mirror set with `KOSHA_SNAPSHOT_URL` and no `KOSHA_SNAPSHOT_PUBKEY`
 * is the operator's own choice of source.
 */
export function snapshotTrustedKeys(url: string): readonly string[] | null {
	const pinned = process.env[SNAPSHOT_PUBLIC_KEY_ENV];
	if (pinned?.trim()) return [pinned.replace(/\\n/g, "\n")];
	return url === SNAPSHOT_CATALOG_URL ? SNAPSHOT_PUBLIC_KEYS : null;
}

/** Fetch `<url>.sig` and check it signs exactly `text`. Throws otherwise. */
async function verifySnapshotSignature(url: string, text: string, keys: readonly string[]): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${url}.sig`, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
	if (!response.ok) throw new Error(`kosha snapshot signature missing: ${response.status} ${response.statusText}`);
	const signature = Buffer.from((await readBoundedText(response, MAX_SIGNATURE_BYTES)).trim(), "base64");
	if (!snapshotSignatureValid(text, signature, keys)) {
		throw new Error("kosha snapshot signature does not verify — refusing to load");
	}
}

/** True if `signature` is an Ed25519 signature of `text` by one of `keys`. */
export function snapshotSignatureValid(text: string, signature: Buffer, keys: readonly string[]): boolean {
	if (signature.length !== 64) return false;
	const data = Buffer.from(text, "utf8");
	return keys.some((pem) => {
		try {
			return verify(null, data, createPublicKey(pem), signature);
		} catch {
			return false; // a malformed key never verifies
		}
	});
}

/**
 * Parse and validate a catalog in the snapshot format. Shared by the
 * published snapshot and the `local` catalog file, so both get the same
 * caps and the same threat scan. `label` names the source in errors.
 */
export function parseSnapshotCatalog(text: string, label: string): SnapshotCatalog {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Failed to parse ${label}: invalid JSON`);
	}
	// Exports and newer snapshots carry `kind` and `schemaVersion`; older
	// snapshots have neither. A file that names another kind, or a version
	// this kosha does not know, is refused rather than half-read.
	const envelope = parsed as { kind?: unknown; schemaVersion?: unknown } | null;
	if (envelope?.kind !== undefined && envelope.kind !== "kosha-catalog") {
		throw new Error(`Failed to parse ${label}: kind "${String(envelope.kind)}" is not a kosha catalog`);
	}
	if (envelope?.schemaVersion !== undefined && envelope.schemaVersion !== 1) {
		throw new Error(`Failed to parse ${label}: unsupported schemaVersion ${String(envelope.schemaVersion)}`);
	}
	const providers = (parsed as { providers?: unknown })?.providers;
	if (!Array.isArray(providers)) {
		throw new Error(`Failed to parse ${label}: expected a providers array`);
	}
	if (providers.length > MAX_PROVIDERS) {
		throw new Error(`${label} exceeds provider cap (${providers.length} > ${MAX_PROVIDERS}) — refusing to load`);
	}

	// Key by provider id so the threat scan can quarantine one provider's
	// rows without discarding the rest — the same shape the other loaders use.
	const byId: Record<string, unknown> = Object.create(null);
	for (const entry of providers) {
		const provider = entry as SnapshotProvider;
		if (!provider || typeof provider !== "object" || typeof provider.id !== "string") continue;
		byId[provider.id] = Array.isArray(provider.models) ? provider.models : [];
	}
	const { clean } = quarantineEntries(byId, label);

	const out = new Map<string, ModelCard[]>();
	for (const [id, models] of Object.entries(clean)) {
		if (!Array.isArray(models)) continue;
		const cards = models.filter(isModelCardShape).filter((card) => card.provider === id);
		if (cards.length > 0) out.set(id, cards);
	}
	const fetchedAt = (parsed as { fetchedAt?: unknown }).fetchedAt;
	return { providers: out, fetchedAt: typeof fetchedAt === "string" ? fetchedAt : null };
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
