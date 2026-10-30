/**
 * kosha-discovery — Where keyless catalog data comes from.
 *
 * Without an API key, kosha learns about models from catalogs it does not
 * own: models.dev and LiteLLM. If either one shuts down or ships poisoned
 * data, this is the switch that takes them out of the loop:
 *
 *  - `community` (default): models.dev first, LiteLLM as filler and for
 *    enrichment, kosha's weekly snapshot when both are unreachable.
 *  - `pinned`: kosha's own published snapshot only. No models.dev, no LiteLLM.
 *  - `local`: a catalog file on disk (`kosha registry export` writes one).
 *    Never touches the network for catalog data. A missing or broken file is
 *    an error, never a silent fallback to the network.
 *
 * Provider APIs called with your own key are official sources and run in
 * every mode. `KOSHA_CATALOG_SOURCE` and `KOSHA_CATALOG_FILE` override config.
 * @module
 */

import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { loadSnapshotCatalog, parseSnapshotCatalog, type SnapshotCatalog } from "./discovery/snapshot-catalog.js";
import type { KoshaConfig, ModelCard, ProviderInfo } from "./types.js";

export type CatalogSource = "community" | "pinned" | "local";

export const CATALOG_SOURCES: readonly CatalogSource[] = ["community", "pinned", "local"];
export const CATALOG_SOURCE_ENV = "KOSHA_CATALOG_SOURCE";
export const CATALOG_FILE_ENV = "KOSHA_CATALOG_FILE";

/** Envelope version for `kosha registry export` and the published snapshot. */
export const CATALOG_SCHEMA_VERSION = 1;
export const CATALOG_KIND = "kosha-catalog";

/** Same cap as the published snapshot; ours is ~3 MB today. */
const MAX_LOCAL_BYTES = 16 * 1024 * 1024;

export interface ResolvedCatalogSource {
	mode: CatalogSource;
	/** Absolute path of the catalog file; set only in `local` mode. */
	file?: string;
	/** Where the mode came from, for `kosha doctor`. */
	origin: "default" | "config" | "env";
}

let configured: { mode?: CatalogSource; file?: string } = {};
let localInflight: Promise<SnapshotCatalog> | null = null;

export function isCatalogSource(value: unknown): value is CatalogSource {
	return typeof value === "string" && (CATALOG_SOURCES as readonly string[]).includes(value);
}

/**
 * Record the config's choice. Called by the registry constructor, so the
 * last registry built sets it for the process; the env still wins.
 */
export function configureCatalogSource(config?: Pick<KoshaConfig, "catalogSource" | "catalogFile">): void {
	configured = {
		mode: isCatalogSource(config?.catalogSource) ? config.catalogSource : undefined,
		file: typeof config?.catalogFile === "string" ? config.catalogFile : undefined,
	};
	localInflight = null;
}

/**
 * The mode in force right now. An unknown value in the env is an error
 * rather than a quiet fallback: someone who typed `KOSHA_CATALOG_SOURCE=locl`
 * meant to stop the network fetch.
 */
export function resolveCatalogSource(): ResolvedCatalogSource {
	const envMode = process.env[CATALOG_SOURCE_ENV]?.trim();
	let mode: CatalogSource = "community";
	let origin: ResolvedCatalogSource["origin"] = "default";
	if (envMode) {
		if (!isCatalogSource(envMode)) {
			throw new Error(`${CATALOG_SOURCE_ENV}="${envMode}" is not one of: ${CATALOG_SOURCES.join(", ")}`);
		}
		mode = envMode;
		origin = "env";
	} else if (configured.mode) {
		mode = configured.mode;
		origin = "config";
	}
	if (mode !== "local") return { mode, origin };

	const raw = process.env[CATALOG_FILE_ENV]?.trim() || configured.file;
	if (!raw) {
		throw new Error(
			`catalog source is "local" but no catalog file is set (${CATALOG_FILE_ENV} or catalogFile in ~/.kosharc.json)`,
		);
	}
	return { mode, file: expandPath(raw), origin };
}

/**
 * Prefix a cache key with the mode, so data cached in `community` mode is
 * never served after switching away from it. `community` keeps the bare
 * keys, so existing caches stay valid.
 */
export function catalogCacheKey(key: string): string {
	const { mode } = resolveCatalogSource();
	return mode === "community" ? key : `${mode}_${key}`;
}

/** Seed cards for one provider from the local catalog file. */
export async function getLocalSeed(providerId: string): Promise<ModelCard[]> {
	const { file } = resolveCatalogSource();
	if (!file) return [];
	const catalog = await loadLocalCatalog(file);
	const now = Date.now();
	return (catalog.providers.get(providerId) ?? []).map((card) => ({
		...card,
		discoveredAt: now,
		catalogSource: "local",
	}));
}

/** Load and validate the local catalog once per process (per file). */
export function loadLocalCatalog(file: string): Promise<SnapshotCatalog> {
	if (localInflight) return localInflight;
	localInflight = readLocalCatalog(file).catch((error) => {
		localInflight = null;
		throw error;
	});
	return localInflight;
}

/** The catalog the active mode reads from, for enrichment outside `community`. */
export async function loadActiveCatalog(): Promise<SnapshotCatalog | null> {
	const source = resolveCatalogSource();
	if (source.mode === "local" && source.file) return loadLocalCatalog(source.file);
	if (source.mode === "pinned") return loadSnapshotCatalog();
	return null;
}

/**
 * Run before discovery. In `local` mode a missing or invalid file throws
 * here, because past this point a seed failure only degrades a provider to
 * its bundled static list, quietly. A bad env value throws in every mode.
 */
export async function assertCatalogReady(): Promise<void> {
	const source = resolveCatalogSource();
	if (source.mode === "local" && source.file) await loadLocalCatalog(source.file);
}

/** What `kosha doctor` reports about the catalog in use. */
export interface CatalogReport {
	mode: CatalogSource | null;
	origin: ResolvedCatalogSource["origin"] | null;
	file?: string;
	/** When the catalog was built; community catalogs are fetched live and have none. */
	fetchedAt?: string;
	ageDays?: number;
	error?: string;
}

/**
 * Describe the active catalog, loading it outside `community` to read its
 * age. Never throws: a broken setup is exactly what doctor must show.
 */
export async function describeCatalog(now = Date.now()): Promise<CatalogReport> {
	let source: ResolvedCatalogSource;
	try {
		source = resolveCatalogSource();
	} catch (error) {
		return { mode: null, origin: null, error: (error as Error).message };
	}
	const report: CatalogReport = { mode: source.mode, origin: source.origin, file: source.file };
	if (source.mode === "community") return report;
	try {
		const catalog = await loadActiveCatalog();
		const built = catalog?.fetchedAt ? Date.parse(catalog.fetchedAt) : Number.NaN;
		if (catalog?.fetchedAt && Number.isFinite(built)) {
			report.fetchedAt = catalog.fetchedAt;
			report.ageDays = Math.max(0, Math.floor((now - built) / 86_400_000));
		}
	} catch (error) {
		report.error = (error as Error).message;
	}
	return report;
}

/** The file format shared by `kosha registry export` and the weekly snapshot. */
export interface CatalogEnvelope {
	schemaVersion: typeof CATALOG_SCHEMA_VERSION;
	kind: typeof CATALOG_KIND;
	fetchedAt: string;
	providerScope: string;
	modelCount: number;
	providerCount: number;
	discoveredAt: number;
	providers: ProviderInfo[];
}

/** Wrap discovered providers in the catalog envelope, ready to write as JSON. */
export function buildCatalogEnvelope(
	providers: ProviderInfo[],
	options: { discoveredAt: number; providerScope?: string; now?: Date },
): CatalogEnvelope {
	return {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		kind: CATALOG_KIND,
		fetchedAt: (options.now ?? new Date()).toISOString(),
		providerScope: options.providerScope ?? "all",
		modelCount: providers.reduce((sum, provider) => sum + provider.models.length, 0),
		providerCount: providers.length,
		discoveredAt: options.discoveredAt,
		providers,
	};
}

/** Test hook. */
export function resetCatalogSource(): void {
	configured = {};
	localInflight = null;
}

/**
 * One handle for the check and the read, so the file can't be swapped in
 * between, and the read itself stops at the cap in case the file grows.
 */
async function readLocalCatalog(file: string): Promise<SnapshotCatalog> {
	const handle = await open(file, "r").catch(() => null);
	if (!handle) throw new Error(`local catalog not found: ${file}`);
	try {
		if (!(await handle.stat()).isFile()) throw new Error(`local catalog is not a file: ${file}`);
		const buffer = Buffer.alloc(MAX_LOCAL_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > MAX_LOCAL_BYTES) throw new Error(`local catalog too large (> ${MAX_LOCAL_BYTES} bytes): ${file}`);
		return parseSnapshotCatalog(buffer.toString("utf8", 0, length), `local catalog ${file}`);
	} finally {
		await handle.close();
	}
}

function expandPath(raw: string): string {
	const path = raw === "~" || raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw;
	return isAbsolute(path) ? path : resolve(path);
}
