/**
 * kosha-discovery — Manifest persistence, O_EXCL locking, and rollback backups.
 *
 * Owns disk reads/writes for `~/.kosha/registry.json` and `catalog-only.json`,
 * including cross-process locking, atomic temp-file + POSIX rename, 7-day
 * `.bak` rotation, and `kosha registry accept` persistence.
 * @module
 */

import { randomBytes } from "crypto";
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { resolveCatalogSource } from "./catalog-source.js";
import { buildCatalogOnlyRows } from "./discovery/catalog-only.js";
import type { DiscoverySnapshotV1 } from "./discovery-contract.js";
import { DISCOVERY_SCHEMA_VERSION } from "./discovery-contract.js";
import { mergeManifests, PRICING_SOURCES_DISAGREE, type PricingHold } from "./manifest-merge.js";
import { ANOMALY_FILE, appendAnomalies, detectPricingAnomalies } from "./pricing-anomalies.js";
import { registryDiscoverySnapshot } from "./registry-discovery.js";
import type { RegistryState } from "./registry-state.js";
import { assertCleanPayload } from "./security.js";
import { getSubscriptionPlan } from "./subscription-plans.js";
import type { ModelPricing } from "./types.js";

/**
 * Canonical, third-party consumable registry manifest path.
 * I keep it outside the TTL cache directory so tools like jq, duckdb, or
 * language SDKs can read a single stable file without worrying about
 * cache envelopes or internal layout changes.
 */
export const REGISTRY_MANIFEST_PATH = join(homedir(), ".kosha", "registry.json");

/** Providers known only from the public catalog, beside the registry. */
export const CATALOG_ONLY_FILE = "catalog-only.json";

const MAX_BACKUPS = 7;
const MAX_MANIFEST_BYTES = 50 * 1024 * 1024;
const MAX_CATALOG_ONLY_BYTES = 32 * 1024 * 1024;

interface ExportLock {
	lockPath: string;
	token: string;
}

class UnsupportedManifestSchemaError extends Error {
	constructor(readonly foundVersion: unknown) {
		super(`unsupported manifest schemaVersion: ${String(foundVersion)}`);
	}
}

/** What `kosha registry accept` found for a model. */
export type AcceptHeldPriceResult =
	| { status: "accepted"; held: ModelPricing | null; waitingSince: number }
	| { status: "not-held" }
	| { status: "not-found" };

/** Resolve the on-disk path for the registry manifest. Tests + custom callers
 *  pin via `state.config.cacheDir`; production falls back to ~/.kosha. */
export function resolveManifestPath(state: RegistryState): string {
	const cacheDir = state.config.cacheDir;
	if (cacheDir) return join(dirname(cacheDir), "registry.json");
	return REGISTRY_MANIFEST_PATH;
}

/**
 * Export a stable, human-and-machine-readable manifest of the current
 * registry state to `~/.kosha/registry.json`.
 */
export async function exportRegistryManifest(
	state: RegistryState,
	options?: { catalogOnly?: boolean; scopedProviders?: readonly string[] },
): Promise<DiscoverySnapshotV1 | null> {
	let manifestPath: string | null = null;
	let lock: ExportLock | null = null;
	let fresh: DiscoverySnapshotV1 | null = null;
	let merged: DiscoverySnapshotV1 | null = null;
	try {
		fresh = state.lastSnapshotCache ?? registryDiscoverySnapshot(state);
		state.lastSnapshotCache = fresh;
		manifestPath = resolveManifestPath(state);
		await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
		await sweepStaleTmpFiles(manifestPath);

		lock = await acquireExportLock(`${manifestPath}.lock`);

		const previousManifest = await readPreviousManifest(manifestPath);
		merged = mergeManifests(previousManifest, fresh, { scopedProviders: options?.scopedProviders });

		try {
			const anomalies = detectPricingAnomalies(previousManifest, fresh);
			if (anomalies.length > 0) {
				const logged = await appendAnomalies(dirname(manifestPath), anomalies);
				if (logged > 0) {
					const path = join(dirname(manifestPath), ANOMALY_FILE);
					console.warn(`[kosha] ${logged} pricing change(s) logged to ${path}`);
				}
			}
		} catch {
			// Anomaly logging is observability only; never block manifest export.
		}

		const tmpPath = `${manifestPath}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(tmpPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
			await rotateBackup(manifestPath);
			await rename(tmpPath, manifestPath);
		} catch (err) {
			await unlink(tmpPath).catch(() => {});
			throw err;
		}
		// Release the manifest lock BEFORE the slow network catalog-only build so
		// concurrent refreshes or `registry accept` calls never hit the 3s lock timeout.
		await releaseExportLock(lock);
		lock = null;
		warnOnNewlyDisputedPrices(previousManifest, merged);
		if (options?.catalogOnly !== false)
			await exportCatalogOnlyManifest(manifestPath, new Set(state.providerMap.keys()));
		return merged;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(`[kosha] manifest export failed (${manifestPath ?? "unknown path"}): ${reason}`);
		if (!merged && fresh) {
			try {
				const previous = manifestPath ? await readPreviousManifest(manifestPath) : null;
				merged = mergeManifests(previous, fresh, { scopedProviders: options?.scopedProviders });
			} catch {
				// Nothing left to judge against; the caller keeps what it has.
			}
		}
		return merged;
	} finally {
		if (lock) {
			await releaseExportLock(lock);
		}
	}
}

/**
 * Accept the price a quarantine is holding for one model. The hold remembers
 * exactly which rates it's waiting on, so the acceptance covers those rates
 * only: the next discovery pass takes them, and a different publish after
 * that is judged afresh. Writes the manifest under the export lock.
 */
export async function acceptHeldPrice(
	state: RegistryState,
	providerId: string,
	modelId: string,
): Promise<AcceptHeldPriceResult> {
	const manifestPath = resolveManifestPath(state);
	const lock = await acquireExportLock(`${manifestPath}.lock`);
	try {
		const manifest = await readManifestFile(manifestPath);
		const row = manifest?.models.find((m) => m.providerId === providerId && m.modelId === modelId);
		if (!manifest || !row) return { status: "not-found" };
		const hold = (row as { pricingHold?: PricingHold }).pricingHold;
		if (!hold || !(row.rawCapabilities ?? []).includes("pricing_quarantined")) return { status: "not-held" };
		(row as { pricingHold?: PricingHold }).pricingHold = { ...hold, accepted: true };
		const tmpPath = `${manifestPath}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(tmpPath, JSON.stringify(manifest, null, 2), { encoding: "utf-8", mode: 0o600 });
			await rename(tmpPath, manifestPath);
		} catch (err) {
			await unlink(tmpPath).catch(() => {});
			throw err;
		}
		return { status: "accepted", held: row.pricing ?? null, waitingSince: hold.since };
	} finally {
		await releaseExportLock(lock);
	}
}

/** Read the current manifest or fall back to the newest readable `.bak` copy. */
export async function readPreviousManifest(manifestPath: string): Promise<DiscoverySnapshotV1 | null> {
	try {
		const current = await readManifestFile(manifestPath, true);
		if (current) return current;
	} catch (err) {
		if (err instanceof UnsupportedManifestSchemaError) {
			// Do not downgrade a newer schema file to an older `.bak` copy.
			return null;
		}
	}
	for (const backup of await listBackups(manifestPath)) {
		const parsed = await readManifestFile(backup);
		if (parsed) return parsed;
	}
	return null;
}

async function readManifestFile(path: string, throwOnUnsupportedSchema = false): Promise<DiscoverySnapshotV1 | null> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const { size } = await handle.stat();
		if (size > MAX_MANIFEST_BYTES) return null;
		const raw = await handle.readFile("utf-8");
		const parsed = JSON.parse(raw) as DiscoverySnapshotV1;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) return null;
		if (parsed.schemaVersion !== DISCOVERY_SCHEMA_VERSION) {
			if (throwOnUnsupportedSchema) throw new UnsupportedManifestSchemaError(parsed.schemaVersion);
			return null;
		}
		assertCleanPayload(parsed, "registry manifest");
		return parsed;
	} catch (err) {
		if (err instanceof UnsupportedManifestSchemaError) throw err;
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function listBackups(manifestPath: string): Promise<string[]> {
	const dir = dirname(manifestPath);
	const base = manifestPath.slice(dir.length + 1);
	const bakRe = new RegExp(`^${escapeRegExp(base)}\\.bak\\.\\d{4}-\\d{2}-\\d{2}$`);
	try {
		return (await readdir(dir))
			.filter((name) => bakRe.test(name))
			.sort()
			.reverse()
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

async function acquireExportLock(lockPath: string): Promise<ExportLock> {
	const STALE_AFTER_MS = 30_000;
	const MAX_WAIT_MS = 3_000;
	const startedAt = Date.now();
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
	for (let attempt = 0; ; attempt++) {
		try {
			const fd = await open(lockPath, "wx");
			await fd.write(`${token}\n`);
			await fd.close();
			return { lockPath, token };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			try {
				const s = await stat(lockPath);
				if (Date.now() - s.mtimeMs > STALE_AFTER_MS) {
					// Atomically claim the stale file via rename before unlinking so two
					// waiters never delete a third waiter's freshly acquired lock.
					const staleTmp = `${lockPath}.stale.${token}`;
					await rename(lockPath, staleTmp).catch(() => {});
					await unlink(staleTmp).catch(() => {});
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() - startedAt > MAX_WAIT_MS) {
				throw new Error(`kosha manifest export: lock contention (${lockPath})`);
			}
			const delay = Math.min(800, 50 * 2 ** attempt) + Math.floor(Math.random() * 50);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

async function releaseExportLock(lock: ExportLock): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(lock.lockPath, "r");
		const current = (await handle.readFile("utf-8")).trim();
		await handle.close();
		handle = undefined;
		if (current === lock.token) {
			await unlink(lock.lockPath).catch(() => {});
		}
	} catch {
		// Lock already missing or inaccessible.
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function rotateBackup(manifestPath: string): Promise<void> {
	try {
		const dir = dirname(manifestPath);
		const base = manifestPath.slice(dir.length + 1);
		const today = new Date().toISOString().slice(0, 10);
		const todayBak = join(dir, `${base}.bak.${today}`);

		try {
			await stat(todayBak);
			return;
		} catch {
			// slot is free
		}

		const { readFile } = await import("fs/promises");
		let data: Buffer;
		try {
			data = await readFile(manifestPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
			throw err;
		}
		const tmp = `${todayBak}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(tmp, data, { mode: 0o600 });
			await rename(tmp, todayBak);
		} catch (err) {
			await unlink(tmp).catch(() => {});
			throw err;
		}

		const bakRe = new RegExp(`^${escapeRegExp(base)}\\.bak\\.(\\d{4}-\\d{2}-\\d{2})$`);
		const entries = await readdir(dir);
		const bakDates = entries
			.map((name) => {
				const m = bakRe.exec(name);
				return m ? { name, date: m[1] } : null;
			})
			.filter((x): x is { name: string; date: string } => x !== null)
			.sort((a, b) => a.date.localeCompare(b.date));
		const expired = bakDates.slice(0, Math.max(0, bakDates.length - MAX_BACKUPS));
		await Promise.all(expired.map((b) => unlink(join(dir, b.name)).catch(() => {})));
	} catch {
		// Rotation is observability/recovery only — don't gate the export.
	}
}

async function sweepStaleTmpFiles(manifestPath: string): Promise<void> {
	try {
		const dir = dirname(manifestPath);
		const base = manifestPath.slice(dir.length + 1);
		const tmpRe = new RegExp(`^${escapeRegExp(base)}\\.[0-9a-f]+\\.tmp$`);
		const fiveMinAgo = Date.now() - 5 * 60_000;
		const entries = await readdir(dir);
		await Promise.all(
			entries
				.filter((name) => tmpRe.test(name))
				.map(async (name) => {
					const p = join(dir, name);
					try {
						const s = await stat(p);
						if (s.mtimeMs < fiveMinAgo) await unlink(p);
					} catch {
						// raced with another sweeper or unlinked already
					}
				}),
		);
	} catch {
		// Sweep is best-effort
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function warnOnNewlyDisputedPrices(previous: DiscoverySnapshotV1 | null, merged: DiscoverySnapshotV1): void {
	const disputed = (snapshot: DiscoverySnapshotV1 | null) =>
		(snapshot?.models ?? []).filter((m) => m.rawCapabilities?.includes(PRICING_SOURCES_DISAGREE)).map((m) => m.key);
	const known = new Set(disputed(previous));
	const fresh = disputed(merged).filter((key) => !known.has(key));
	if (fresh.length > 0) {
		console.warn(`[kosha] ${fresh.length} price(s) where sources disagree, e.g. ${fresh[0]}`);
	}
}

async function exportCatalogOnlyManifest(manifestPath: string, listedIds: ReadonlySet<string>): Promise<void> {
	if (resolveCatalogSource().mode !== "community") return;
	const path = join(dirname(manifestPath), CATALOG_ONLY_FILE);
	let tmpPath: string | null = null;
	try {
		const { getAllDiscoverers } = await import("./discovery/index.js");
		const claimed = getAllDiscoverers()
			.map((discoverer) => discoverer.providerId)
			.filter((id) => !getSubscriptionPlan(id) || listedIds.has(id));
		const models = await buildCatalogOnlyRows(claimed);
		if (models.length === 0) return;
		const fresh = {
			schemaVersion: DISCOVERY_SCHEMA_VERSION,
			discoveredAt: Date.now(),
			cursor: "",
			providers: [],
			models,
			roles: [],
			health: [],
			credentialPrompts: [],
		} as unknown as DiscoverySnapshotV1;
		const merged = mergeManifests(await readPreviousManifest(path), fresh);
		const body = JSON.stringify(merged);
		if (Buffer.byteLength(body) > MAX_CATALOG_ONLY_BYTES) {
			throw new Error(`${CATALOG_ONLY_FILE} would exceed ${MAX_CATALOG_ONLY_BYTES} bytes`);
		}
		assertCleanPayload(merged, CATALOG_ONLY_FILE);
		tmpPath = `${path}.${randomBytes(4).toString("hex")}.tmp`;
		await writeFile(tmpPath, body, { encoding: "utf-8", mode: 0o600 });
		await rename(tmpPath, path);
	} catch (err) {
		if (tmpPath) await unlink(tmpPath).catch(() => {});
		console.warn(`[kosha] ${CATALOG_ONLY_FILE} not updated: ${err instanceof Error ? err.message : String(err)}`);
	}
}
