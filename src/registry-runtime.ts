/**
 * kosha-discovery — Discovery, enrichment, and cache helpers.
 *
 * I keep provider discovery and runtime plumbing here so the registry façade
 * can stay small without losing the existing behavior.
 * @module
 */

import { randomBytes } from "crypto";
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { DiscoverySnapshotV1 } from "./discovery-contract.js";
import { DISCOVERY_SCHEMA_VERSION } from "./discovery-contract.js";
import { getProviderConfig, getProviderDescriptor, isLocalProvider, normalizeProviderId } from "./provider-catalog.js";
import { registryDiscoverySnapshot } from "./registry-discovery.js";
import type { DiscoveryDependencies, RegistryState } from "./registry-state.js";
import { StaleCachePolicy } from "./resilience.js";
import type { CredentialResult, DiscoveryOptions, Enricher, ModelCard, ProviderDiscoverer, ProviderInfo } from "./types.js";
import { applyPromoOverrides } from "./discovery/promo-overrides.js";
import { assertCleanPayload } from "./security.js";

const DEFAULT_CACHE_TTL_MS = 86_400_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_KEY_PREFIX = "provider_";

/**
 * Canonical, third-party consumable registry manifest path.
 * I keep it outside the TTL cache directory so tools like jq, duckdb, or
 * language SDKs can read a single stable file without worrying about
 * cache envelopes or internal layout changes.
 */
export const REGISTRY_MANIFEST_PATH = join(homedir(), ".kosha", "registry.json");

/**
 * Run provider discovery, enrichment, caching, and delta emission.
 */
export async function registryDiscover(
	state: RegistryState,
	dependencies: DiscoveryDependencies,
	options?: DiscoveryOptions,
): Promise<ProviderInfo[]> {
	const beforeSnapshot = dependencies.snapshotForDelta();
	const providers = options?.providers?.map((providerId) => normalizeProviderId(providerId) ?? providerId);
	const force = options?.force ?? false;

	if (!force) {
		const loaded = await dependencies.loadFromCache(providers);
		if (loaded) {
			// Attribute pricing provenance on cache rehydration so entries
			// persisted before pricingSource existed still get a trustworthy
			// tag. No enrichment ran here, so every priced model is treated
			// as discovery-origin.
			attributePricingSources(state, capturePricedModelKeys(state));
			dependencies.recordDiscoveryMutation(beforeSnapshot);
			// Only refresh the canonical manifest for full-registry cache hits.
			// Scoped provider rehydration can carry cache-derived state that should
			// not be published as a fresh top-level manifest snapshot.
			if (!providers || providers.length === 0) {
				await exportRegistryManifest(state);
			}
			return Array.from(state.providerMap.values());
		}
	}

	const discoverers = await dependencies.loadDiscoverers(providers, options?.includeLocal);
	const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
	const results = await Promise.allSettled(
		discoverers.map((discoverer) => discoverProvider(state, dependencies, discoverer, timeout)),
	);

	state.lastDiscoveryErrors = [];
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		if (result.status === "fulfilled") {
			if (result.value) {
				state.providerMap.set(result.value.id, result.value);
			}
			continue;
		}

		const discoverer = discoverers[index];
		state.lastDiscoveryErrors.push({
			providerId: discoverer.providerId,
			providerName: discoverer.providerName,
			error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			timestamp: Date.now(),
		});
	}

	// Snapshot which models the discoverers already priced, BEFORE the
	// litellm enrichment pass runs. Pricing present here is attributed to
	// the discoverer's own origin (provider-live API vs static seed);
	// pricing that only appears after enrichment is attributed to litellm.
	const preEnrichmentPriced = capturePricedModelKeys(state);

	if (options?.enrichWithPricing ?? true) {
		await dependencies.enrichModels();
	}

	// Apply promo overrides as a final pricing pass so deals always win
	// regardless of discovery path (API, seed, or enrichment).
	for (const [providerId, providerInfo] of state.providerMap) {
		state.providerMap.set(providerId, {
			...providerInfo,
			models: applyPromoOverrides(providerInfo.models),
		});
	}

	// Attribute pricing provenance at the enrich/merge boundary now that
	// every pricing pass (API, seed, litellm enrichment, promo) has run.
	attributePricingSources(state, preEnrichmentPriced);

	dependencies.populateModelAliases();
	state.discoveredAt = Date.now();
	await dependencies.saveToCache();
	dependencies.recordDiscoveryMutation(beforeSnapshot);
	// Write the consumer-facing manifest last, after recordDiscoveryMutation
	// has advanced the cursor — that way the snapshot's cursor reflects the
	// post-discovery revision instead of a stale pre-mutation value.
	await exportRegistryManifest(state);
	return Array.from(state.providerMap.values());
}

/**
 * Force a fresh discovery pass for one provider or the full registry.
 */
export async function registryRefresh(
	state: RegistryState,
	discover: (options?: DiscoveryOptions) => Promise<ProviderInfo[]>,
	providerId?: string,
): Promise<void> {
	if (providerId) {
		const normalizedProviderId = normalizeProviderId(providerId) ?? providerId;
		await state.cache.invalidate(`${CACHE_KEY_PREFIX}${normalizedProviderId}`);
		await discover({ providers: [normalizedProviderId], force: true });
		return;
	}

	await state.cache.clear();
	await discover({ force: true });
}

/**
 * Dynamically load discoverers while respecting config and local filters.
 */
export async function loadRegistryDiscoverers(
	state: RegistryState,
	providerIds?: string[],
	includeLocal?: boolean,
): Promise<ProviderDiscoverer[]> {
	try {
		const discoveryModule = await import("./discovery/index.js");
		let discoverers: ProviderDiscoverer[] = discoveryModule.getAllDiscoverers({
			ollamaBaseUrl: getProviderConfig(state.config, "ollama")?.baseUrl,
			llamaCppBaseUrl: getProviderConfig(state.config, "llama.cpp")?.baseUrl,
		});

		if (providerIds && providerIds.length > 0) {
			const normalizedProviderIds = providerIds.map((providerId) => normalizeProviderId(providerId) ?? providerId);
			discoverers = discoverers.filter((discoverer) => normalizedProviderIds.includes(discoverer.providerId));
		}

		if (includeLocal === false) {
			discoverers = discoverers.filter((discoverer) => !isLocalProvider(discoverer.providerId));
		}

		if (state.config.providers) {
			discoverers = discoverers.filter(
				(discoverer) => getProviderConfig(state.config, discoverer.providerId)?.enabled !== false,
			);
		}

		return discoverers;
	} catch {
		return [];
	}
}

/**
 * Dynamically load the credential resolver when available.
 */
export async function getRegistryCredentialResolver(): Promise<{
	resolve: (providerId: string, explicitKey?: string) => Promise<CredentialResult>;
} | null> {
	try {
		const { CredentialResolver } = await import("./credentials/index.js");
		return new CredentialResolver();
	} catch {
		return null;
	}
}

/**
 * Resolve a credential from config or environment without the credential module.
 */
export function fallbackRegistryCredential(providerId: string, explicitKey?: string): CredentialResult {
	const normalizedProviderId = normalizeProviderId(providerId) ?? providerId;
	if (explicitKey) {
		return { apiKey: explicitKey, source: "config" };
	}

	if (normalizedProviderId === "vercel") {
		const apiKey = process.env.AI_GATEWAY_API_KEY;
		if (apiKey) return { apiKey, source: "env" };
		const oidcToken = process.env.VERCEL_OIDC_TOKEN;
		if (oidcToken) return { accessToken: oidcToken, source: "env" };
	}

	const envVar = getProviderDescriptor(normalizedProviderId)?.primaryCredentialEnvVar;
	const value = envVar ? process.env[envVar] : undefined;
	return value ? { apiKey: value, source: "env" } : { source: "none" };
}

/**
 * Enrich the in-memory model set with pricing metadata when available.
 */
export async function enrichRegistryModels(state: RegistryState): Promise<void> {
	try {
		const { LiteLLMEnricher } = await import("./enrichment/index.js");
		const enricher: Enricher = new LiteLLMEnricher();

		for (const [providerId, providerInfo] of state.providerMap) {
			try {
				const enriched = await enricher.enrich(providerInfo.models);
				state.providerMap.set(providerId, { ...providerInfo, models: enriched });
			} catch {
				// I keep enrichment failures non-fatal so base discovery remains useful.
			}
		}
	} catch {
		// I silently skip enrichment when the optional module is not present.
	}
}
/**
 * Enrichment-only result for the `kosha enrich` CLI command.
 */
export interface EnrichOnlyResult {
	/** Total models across all providers. */
	modelCount: number;
	/** Models that gained new cache read/write pricing. */
	cachePricingUpdated: number;
	/** Models that gained new batch pricing. */
	batchPricingUpdated: number;
}

/**
 * Load cached provider data, re-run LiteLLM enrichment, and persist results.
 *
 * This is the lightweight alternative to full re-discovery — no provider API
 * calls, just a fetch from the litellm community catalogue. Returns `null`
 * when no cached data is available.
 */
export async function registryEnrichOnly(state: RegistryState): Promise<EnrichOnlyResult | null> {
	const ttl = state.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const allEntry = await state.cache.get<ProviderInfo[]>("providers_all");
	if (!allEntry) return null;

	// Accept stale cache too — enrichment-only shouldn't fail just because
	// the TTL expired. The user explicitly asked for enrichment, not discovery.
	for (const provider of allEntry.data) {
		state.providerMap.set(provider.id, provider);
	}
	state.discoveredAt = allEntry.timestamp;

	// Snapshot pricing before enrichment to count how many models get updates.
	const before = countPricingFields(state);
	// Snapshot which models were already priced before this enrichment-only
	// pass, so provenance attribution can tell litellm-filled rates apart
	// from rates the cache already carried.
	const preEnrichmentPriced = capturePricedModelKeys(state);

	await enrichRegistryModels(state);
	for (const [providerId, providerInfo] of state.providerMap) {
		state.providerMap.set(providerId, {
			...providerInfo,
			models: applyPromoOverrides(providerInfo.models),
		});
	}
	attributePricingSources(state, preEnrichmentPriced);
	populateRegistryModelAliases(state);
	await saveRegistryToCache(state);
	await exportRegistryManifest(state);

	const after = countPricingFields(state);
	return {
		modelCount: Array.from(state.providerMap.values()).reduce((sum, p) => sum + p.models.length, 0),
		cachePricingUpdated: Math.max(0, after.cachePricing - before.cachePricing),
		batchPricingUpdated: Math.max(0, after.batchPricing - before.batchPricing),
	};
}

function countPricingFields(state: RegistryState): { cachePricing: number; batchPricing: number } {
	let cachePricing = 0;
	let batchPricing = 0;
	for (const providerInfo of state.providerMap.values()) {
		for (const model of providerInfo.models) {
			if (model.pricing?.cacheReadPerMillion !== undefined || model.pricing?.cacheWritePerMillion !== undefined)
				cachePricing++;
			if (model.pricing?.batchInputPerMillion !== undefined || model.pricing?.batchOutputPerMillion !== undefined)
				batchPricing++;
		}
	}
	return { cachePricing, batchPricing };
}

/**
 * True when a model carries defined input AND output rates. Zero counts as
 * defined (free-tier); `undefined` does not. Matches the predicate the
 * cheapest-model query treats as "usable pricing" so attribution and routing
 * agree on what "priced" means.
 */
function modelHasUsablePricing(model: ModelCard): boolean {
	const pricing = model.pricing;
	return (
		!!pricing &&
		pricing.inputPerMillion !== undefined &&
		pricing.outputPerMillion !== undefined
	);
}

/** Stable key for a (provider, model) pair used by provenance snapshots. */
function modelPricingKey(providerId: string, model: ModelCard): string {
	return `${providerId}:${model.id}`;
}

/**
 * Snapshot the set of (provider, model) keys that already carry usable
 * pricing, captured before the litellm enrichment pass so the attribution
 * step can distinguish discovery-origin rates from enrichment-filled ones.
 */
function capturePricedModelKeys(state: RegistryState): Set<string> {
	const keys = new Set<string>();
	for (const [providerId, providerInfo] of state.providerMap) {
		for (const model of providerInfo.models) {
			if (modelHasUsablePricing(model)) {
				keys.add(modelPricingKey(providerId, model));
			}
		}
	}
	return keys;
}

/**
 * Attribute `pricingSource` provenance at the enrich/merge boundary.
 *
 * `preEnrichmentPriced` is the snapshot of models that were already priced
 * before the litellm enrichment pass ran. The rules are conservative:
 *
 *  - Already priced before enrichment → discovery origin, split by the
 *    model's `source` field: `"api"` means the serving API returned live
 *    rates (`provider-live`); `"litellm"` / `"manual"` / `"local"` mean a
 *    keyless seed or hand-curated entry supplied the rates (`static-seed`).
 *  - Priced only after enrichment → `litellm`.
 *  - Still unpriced after every pass → `missing`.
 *
 * Idempotent: a model that already carries a `pricingSource` (e.g. carried
 * in from a cache written by a newer build, or re-attributed on a second
 * pass) is left untouched.
 */
function attributePricingSources(state: RegistryState, preEnrichmentPriced: Set<string>): void {
	for (const [providerId, providerInfo] of state.providerMap) {
		for (const model of providerInfo.models) {
			if (model.pricingSource) continue;
			if (modelHasUsablePricing(model)) {
				const fromDiscovery = preEnrichmentPriced.has(modelPricingKey(providerId, model));
				model.pricingSource = fromDiscovery
					? model.source === "api"
						? "provider-live"
						: "static-seed"
					: "litellm";
			} else {
				model.pricingSource = "missing";
			}
		}
	}
}

/**
 * Populate reverse aliases onto discovered models for legacy consumers.
 */
export function populateRegistryModelAliases(state: RegistryState): void {
	for (const providerInfo of state.providerMap.values()) {
		for (const model of providerInfo.models) {
			const reverseAliases = state.aliasResolver.reverseAliases(model.id);
			if (reverseAliases.length > 0) {
				model.aliases = reverseAliases;
			}
		}
	}
}

/**
 * Load provider data from disk cache when it is still fresh.
 */
export async function loadRegistryFromCache(state: RegistryState, providerIds?: string[]): Promise<boolean> {
	const ttl = state.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

	if (!providerIds || providerIds.length === 0) {
		const allEntry = await state.cache.get<ProviderInfo[]>("providers_all");
		if (!allEntry || state.cache.isExpired(allEntry.timestamp, ttl)) {
			return false;
		}

		for (const provider of allEntry.data) {
			state.providerMap.set(provider.id, provider);
		}
		state.discoveredAt = allEntry.timestamp;
		return true;
	}

	for (const providerId of providerIds) {
		const entry = await state.cache.get<ProviderInfo>(`${CACHE_KEY_PREFIX}${providerId}`);
		if (!entry || state.cache.isExpired(entry.timestamp, ttl)) {
			return false;
		}
		state.providerMap.set(providerId, entry.data);
	}

	state.discoveredAt = Date.now();
	return true;
}

/**
 * Persist the current provider map to the shared file cache.
 */
export async function saveRegistryToCache(state: RegistryState): Promise<void> {
	try {
		const providers = Array.from(state.providerMap.values());
		const saves = providers.map((provider) => state.cache.set(`${CACHE_KEY_PREFIX}${provider.id}`, provider));
		saves.push(state.cache.set("providers_all", providers));
		await Promise.all(saves);
	} catch {
		// I intentionally ignore cache write failures so discovery still succeeds.
	}
}

/**
 * Export a stable, human-and-machine-readable manifest of the current
 * registry state to `~/.kosha/registry.json`. Third-party consumers
 * (CLIs in other languages, jq pipelines, CI jobs, dashboards) can read
 * this file directly — it holds the stable v1 discovery snapshot schema,
 * not the internal cache envelope.
 *
 * I make this a best-effort write: if the filesystem refuses, discovery
 * still completed successfully, so I swallow errors rather than failing
 * the whole command.
 */
export async function exportRegistryManifest(state: RegistryState): Promise<void> {
	let manifestPath: string | null = null;
	let lockReleased = true;
	let lockPath: string | null = null;
	try {
		const fresh = state.lastSnapshotCache ?? registryDiscoverySnapshot(state);
		state.lastSnapshotCache = fresh;
		// Honour state.config.cacheDir so isolated tests (and any other caller
		// that pins a custom cache root) don't clobber the user's real
		// ~/.kosha/registry.json. Without this, running the kosha test suite
		// silently overwrote the user's manifest with an empty one because
		// every test instance triggered an export against the hardcoded path.
		manifestPath = resolveManifestPath(state);
		await mkdir(dirname(manifestPath), { recursive: true });

		// Sweep stale tmp files left over from prior runs that were SIGKILLed
		// mid-write. Each crashed run leaks a `<manifest>.<rand>.tmp` file;
		// without this sweep they accumulate forever (~1.6 MB each).
		await sweepStaleTmpFiles(manifestPath);

		// Cross-process mutex around the read-merge-write critical section.
		// Without this, two concurrent `kosha update` runs both read the same
		// previous manifest, both compute their own merge, and both rename to
		// the final path — last write wins, but the loser's distinct merged
		// additions vanish (lost update).
		lockPath = `${manifestPath}.lock`;
		// Mark `lockReleased = false` ONLY after acquireExportLock returns
		// successfully. If acquire throws (contention timeout, EACCES, …),
		// the finally block must NOT unlink lockPath — that file belongs to
		// the process that's currently holding the lock. Yanking it would
		// let a third caller O_EXCL-acquire while the holder is mid-write,
		// reintroducing the lost-update bug this lock was added to prevent.
		await acquireExportLock(lockPath);
		lockReleased = false;

		// VDOM-style merge: if a previous manifest exists, preserve old
		// providers/models that the fresh fetch dropped. A provider returning
		// 0 models (auth error, rate limit, transient outage) must NOT wipe
		// the user's pricing for those models — they retain their last-known
		// values until a successful fetch supersedes them.
		const previousManifest = await readPreviousManifest(manifestPath);
		const merged = mergeManifests(previousManifest, fresh);

		// Pricing-diff alerts. The most dangerous failure mode isn't "kosha
		// returned null" (we already detect that). It's "kosha returned a
		// wrong number" — silent over- or undercharging. We compare prev vs
		// fresh rates per model and append anomalies (>25% delta) to a
		// rolling 30-day log. Best-effort — never fails the export.
		try {
			const anomalies = detectPricingAnomalies(previousManifest, fresh);
			if (anomalies.length > 0) {
				await appendAnomalies(dirname(manifestPath), anomalies);
				for (const a of anomalies) {
					const tag = a.promo ? " [promo]" : "";
					console.warn(
						`[kosha] pricing anomaly${tag}: ${a.key} ${a.field} ` +
							`${a.previous} → ${a.current} (${(a.deltaPct * 100).toFixed(0)}%)`,
					);
				}
			}
		} catch {
			// Anomaly logging is observability only; never block manifest export.
		}

		// Atomic write: temp file in the same directory, then rename(2).
		// `rename` within a single filesystem is atomic on POSIX and
		// preserves any concurrent reader's existing fd. Without this, a
		// reader (e.g. tokmeter's pricing manifest fallback) can land mid
		// `JSON.stringify` write and parse a truncated file. The tmp suffix
		// uses 8 random hex chars so two concurrent kosha updates don't
		// collide on the staging name.
		const tmpPath = `${manifestPath}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
			// Snapshot rollback ring: rotate the existing manifest into a
			// dated `.bak` slot before the rename overwrites it. Keeps the
			// last 7 snapshots so a bad publish (provider returns garbage,
			// kosha's own bug, hand-edit) has an undo path. Sweeping
			// happens after rename so we never lose the manifest mid-rotate.
			await rotateBackup(manifestPath);
			await rename(tmpPath, manifestPath);
		} catch (err) {
			// Best-effort cleanup of the temp file if rename failed.
			await unlink(tmpPath).catch(() => {});
			throw err;
		}
	} catch (err) {
		// Manifest export is best-effort — the cache still works either way.
		// But silent failure was making permission/disk-full bugs invisible
		// for days. Surface the reason once via stderr; nothing else is
		// gated on a successful export.
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(`[kosha] manifest export failed (${manifestPath ?? "unknown path"}): ${reason}`);
	} finally {
		if (!lockReleased && lockPath) {
			await unlink(lockPath).catch(() => {});
		}
	}
}

/**
 * O_EXCL-based file lock. Tries to create the lock file with `wx` flag —
 * fails if it already exists. Retries with bounded backoff (max ~3s).
 * Stale locks (>30s old) are reclaimed: a kosha process that crashed mid-
 * critical-section won't deadlock future runs.
 */
async function acquireExportLock(lockPath: string): Promise<void> {
	const STALE_AFTER_MS = 30_000;
	const MAX_WAIT_MS = 3_000;
	const startedAt = Date.now();
	for (let attempt = 0; ; attempt++) {
		try {
			const fd = await open(lockPath, "wx");
			await fd.write(`${process.pid}\n`);
			await fd.close();
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			// Lock exists — check if it's stale.
			try {
				const s = await stat(lockPath);
				if (Date.now() - s.mtimeMs > STALE_AFTER_MS) {
					await unlink(lockPath).catch(() => {});
					continue;
				}
			} catch {
				continue; // raced with the holder unlinking
			}
			if (Date.now() - startedAt > MAX_WAIT_MS) {
				throw new Error(`kosha manifest export: lock contention (${lockPath})`);
			}
			// Backoff with jitter: 50, 100, 200, 400, capped at 800ms
			const delay = Math.min(800, 50 * 2 ** attempt) + Math.floor(Math.random() * 50);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

const MAX_BACKUPS = 7;

/**
 * Rotate the current manifest into a `.bak.<YYYY-MM-DD>` slot before it
 * gets overwritten. Keeps the last MAX_BACKUPS snapshots; older ones get
 * unlinked. If today's slot already exists (multiple updates same day),
 * it's preserved — first write of the day wins, since the goal is "what
 * did the manifest look like at the start of each day?"
 *
 * Best-effort: rotation failures don't abort the export. The current
 * manifest is intact regardless.
 */
async function rotateBackup(manifestPath: string): Promise<void> {
	try {
		const dir = dirname(manifestPath);
		const base = manifestPath.slice(dir.length + 1);
		const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		const todayBak = join(dir, `${base}.bak.${today}`);

		// Only rotate if the manifest exists and today's bak slot is empty.
		try {
			await stat(manifestPath);
		} catch {
			return; // no current manifest, nothing to back up
		}
		try {
			await stat(todayBak);
			return; // today's slot already taken — first writer of the day wins
		} catch {
			// fall through — slot is free
		}

		// Copy the current manifest to today's bak slot. We copy rather than
		// rename so the live manifest stays in place during the gap between
		// rotation and the new rename(2) below.
		const { readFile } = await import("fs/promises");
		const data = await readFile(manifestPath);
		const tmp = `${todayBak}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(tmp, data);
			await rename(tmp, todayBak);
		} catch (err) {
			await unlink(tmp).catch(() => {});
			throw err;
		}

		// Sweep older backups down to MAX_BACKUPS.
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

/** Remove any `<manifest>.<...>.tmp` siblings older than 5 minutes. They are
 *  orphans from prior runs that crashed between writeFile and rename. */
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
						// raced with another sweeper or unlinked already — fine
					}
				}),
		);
	} catch {
		// Sweep is best-effort; do not block export on a directory listing failure.
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve the on-disk path for the registry manifest. Tests + custom callers
 *  pin via `state.config.cacheDir`; production falls back to ~/.kosha. */
function resolveManifestPath(state: RegistryState): string {
	const cacheDir = state.config.cacheDir;
	if (cacheDir) return join(dirname(cacheDir), "registry.json");
	return REGISTRY_MANIFEST_PATH;
}

/**
 * Merge a fresh discovery snapshot with the previous manifest on disk.
 *
 * Per-model rule: keep the latest pricing data we've ever seen, keyed by
 * `key` (e.g. `anthropic:claude-opus-4-7`). Fresh entries win when present,
 * but old entries survive if the fresh fetch dropped them (provider 503,
 * no credentials, rate limit, etc.).
 *
 * Per-provider rule: a provider that exists in the old manifest but is
 * absent from the fresh fetch keeps its full entry — same logic, applied
 * to the provider list.
 *
 * If the previous manifest is missing or unreadable we just write the
 * fresh snapshot as-is (first run / corrupted file).
 */
async function readPreviousManifest(manifestPath: string): Promise<DiscoverySnapshotV1 | null> {
	try {
		const { readFile } = await import("fs/promises");
		const raw = await readFile(manifestPath, "utf-8");
		const parsed = JSON.parse(raw) as DiscoverySnapshotV1;
		if (!parsed?.models) return null;
		// Schema-version guard. A different version on disk means we can't
		// trust the field shapes — caller falls through to fresh-only.
		if (parsed.schemaVersion !== DISCOVERY_SCHEMA_VERSION) return null;
		assertCleanPayload(parsed, "registry manifest");
		return parsed;
	} catch {
		return null; // missing or unreadable
	}
}

/** Beyond this fractional rate change in either direction, we treat a fresh
 *  price as suspect and keep the previous value (quarantine). The 25% delta
 *  used by anomaly logging is a UI-alert threshold; quarantine fires only on
 *  a much larger swing so legitimate price updates aren't blocked. */
const PRICING_QUARANTINE_THRESHOLD = 0.75;

/** After this many consecutive discovery passes in which a previously-known
 *  model is missing from the fresh snapshot, the model is dropped from the
 *  merged manifest. Prevents the manifest from becoming a graveyard of
 *  deprecated SKUs while still riding through transient outages. */
const MISSING_RUNS_TTL = 14;

export function mergeManifests(
	previous: DiscoverySnapshotV1 | null,
	fresh: DiscoverySnapshotV1,
): DiscoverySnapshotV1 {
	if (!previous) return fresh;

	// Index previous entries by key so we can both detect collisions AND
	// look back at the old data for pricing-degraded merge below.
	const previousByKey = new Map<string, (typeof previous.models)[number]>();
	for (const m of previous.models) {
		if (m.key) previousByKey.set(m.key, m);
	}

	// Per-model merge with three rules:
	//   (1) Old entries fresh dropped entirely → keep until missingRunCount
	//       exceeds MISSING_RUNS_TTL (model lifecycle TTL).
	//   (2) Fresh entries that came back with NO pricing while the old entry
	//       HAD pricing → keep the old pricing block (degraded-fresh defence).
	//   (3) Fresh entries whose rates moved beyond PRICING_QUARANTINE_THRESHOLD
	//       → keep the previous pricing and tag the row pricing_quarantined,
	//       so a one-shot bad publish (provider returns 0, garbage units, …)
	//       can't silently overcharge or underprice downstream consumers.
	const freshModelKeys = new Set<string>();
	const mergedModels: (typeof fresh.models)[number][] = [];
	for (const f of fresh.models ?? []) {
		if (f.key) freshModelKeys.add(f.key);
		const old = f.key ? previousByKey.get(f.key) : undefined;

		let kept = { ...f, missingRunCount: 0 } as (typeof fresh.models)[number] & { missingRunCount?: number };
		if (old && !hasUsablePricing(f) && hasUsablePricing(old)) {
			// Keep all of fresh's metadata but restore pricing from old.
			kept = { ...kept, pricing: old.pricing, originPricing: old.originPricing };
		} else if (old && quarantinePricingMove(old, f)) {
			// Quarantine the suspect rates: keep the old pricing block and
			// tag the operational `rawCapabilities` array (the trusted
			// `capabilities` taxonomy stays clean, since this isn't a routing
			// signal — it's a "don't trust the freshly-published rate" flag).
			kept = {
				...kept,
				pricing: old.pricing,
				originPricing: old.originPricing,
				rawCapabilities: tagCapability(kept.rawCapabilities, "pricing_quarantined"),
			};
		}
		mergedModels.push(kept);
	}
	for (const old of previous.models) {
		if (!old.key || freshModelKeys.has(old.key)) continue;
		const prevMissing = (old as { missingRunCount?: number }).missingRunCount ?? 0;
		const nextMissing = prevMissing + 1;
		if (nextMissing > MISSING_RUNS_TTL) continue; // drop after TTL
		mergedModels.push({ ...old, missingRunCount: nextMissing } as typeof old);
	}

	const freshProviderIds = new Set((fresh.providers ?? []).map((p) => p.providerId));
	const mergedProviders = [...(fresh.providers ?? [])];
	for (const old of previous.providers ?? []) {
		if (!freshProviderIds.has(old.providerId)) {
			mergedProviders.push(old);
		}
	}

	return {
		...fresh,
		models: mergedModels,
		providers: mergedProviders,
	};
}

/** True if any defined per-million rate moved by more than the quarantine
 *  threshold (either direction), compared to the previous snapshot. */
function quarantinePricingMove(
	previous: { pricing?: unknown; originPricing?: unknown },
	fresh: { pricing?: unknown; originPricing?: unknown },
): boolean {
	type Rates = {
		inputPerMillion?: number;
		outputPerMillion?: number;
		cacheReadPerMillion?: number;
		cacheWritePerMillion?: number;
	} | null | undefined;
	const fields: Array<keyof NonNullable<Rates>> = [
		"inputPerMillion",
		"outputPerMillion",
		"cacheReadPerMillion",
		"cacheWritePerMillion",
	];
	for (const side of ["pricing", "originPricing"] as const) {
		const a = (previous[side] as Rates) ?? null;
		const b = (fresh[side] as Rates) ?? null;
		if (!a || !b) continue;
		for (const field of fields) {
			const prev = a[field];
			const next = b[field];
			if (typeof prev !== "number" || typeof next !== "number") continue;
			if (prev === 0 || next === 0) continue; // zero on either side is a "not reported" placeholder, not a price move
			if (prev === next) continue;
			if (Math.abs((next - prev) / prev) >= PRICING_QUARANTINE_THRESHOLD) return true;
		}
	}
	return false;
}

/** Add a capability tag exactly once, preserving order. */
function tagCapability(existing: string[] | undefined, tag: string): string[] {
	if (!existing) return [tag];
	return existing.includes(tag) ? existing : [...existing, tag];
}

/** True if the entry carries defined input + output rates on EITHER the
 *  origin (direct provider) side OR the proxy (`pricing`) side — even zero
 *  (free-tier). Anything else is "pricing-degraded" for our purposes.
 *
 *  Both sides are checked independently. The earlier `originPricing ?? pricing`
 *  short-circuited on `originPricing` being defined, so a row with
 *  `originPricing = {input:0, output:0}` and `pricing = {input:5, output:15}`
 *  would falsely report degraded — and the caller would then overwrite the
 *  fresh proxy rate with old data. */
function hasUsablePricing(entry: { pricing?: unknown; originPricing?: unknown } | undefined): boolean {
	if (!entry) return false;
	type Rates = { inputPerMillion?: number; outputPerMillion?: number };
	const sideHasPricing = (side: unknown): boolean => {
		const r = side as Rates | null | undefined;
		if (!r) return false;
		return r.inputPerMillion !== undefined && r.outputPerMillion !== undefined;
	};
	return sideHasPricing(entry.originPricing) || sideHasPricing(entry.pricing);
}

/**
 * A single pricing-diff event captured at merge time. Persisted to
 * `<manifest-dir>/anomalies.json` so consumers can surface "rate moved
 * unexpectedly" as a UI signal without polling for every merge.
 */
export interface PricingAnomaly {
	ts: number;
	/** Stable model key, e.g. `anthropic:claude-opus-4-7`. */
	key: string;
	/** Which rate moved: `input`, `output`, `cacheRead`, `cacheWrite`. */
	field: "input" | "output" | "cacheRead" | "cacheWrite";
	/** Whether the change was on `originPricing` (direct) or `pricing` (proxy). */
	side: "origin" | "proxy";
	previous: number;
	current: number;
	/** Signed fractional delta, e.g. -0.5 = 50% drop, +1.0 = doubled. */
	deltaPct: number;
	/** True when either snapshot carried a promo_override tag for this model. */
	promo: boolean;
}

const ANOMALY_DELTA_THRESHOLD = 0.25; // 25% in either direction
const ANOMALY_RETENTION_MS = 30 * 86_400_000; // 30 days
const ANOMALY_MAX_ENTRIES = 5_000; // cap so the file can't grow unbounded
const ANOMALY_FILE = "anomalies.json";

/** Compare prev vs fresh manifests and emit one anomaly per rate-field
 *  that moved more than ANOMALY_DELTA_THRESHOLD. Both directions count
 *  (a 90% rate drop is just as suspicious as a 90% jump). */
function hasPromoFlag(entry: { capabilities?: string[]; rawCapabilities?: string[] } | undefined): boolean {
	if (!entry) return false;
	const caps = entry.rawCapabilities ?? entry.capabilities ?? [];
	return caps.includes("promo_override");
}

function detectPricingAnomalies(
	previous: DiscoverySnapshotV1 | null,
	fresh: DiscoverySnapshotV1,
): PricingAnomaly[] {
	if (!previous?.models) return [];
	const prevByKey = new Map<string, (typeof previous.models)[number]>();
	for (const m of previous.models) {
		if (m.key) prevByKey.set(m.key, m);
	}
	const ts = Date.now();
	const anomalies: PricingAnomaly[] = [];

	type RateBlock = {
		inputPerMillion?: number;
		outputPerMillion?: number;
		cacheReadPerMillion?: number;
		cacheWritePerMillion?: number;
	} | null
		| undefined;
	const fields: { name: PricingAnomaly["field"]; key: keyof NonNullable<RateBlock> }[] = [
		{ name: "input", key: "inputPerMillion" },
		{ name: "output", key: "outputPerMillion" },
		{ name: "cacheRead", key: "cacheReadPerMillion" },
		{ name: "cacheWrite", key: "cacheWritePerMillion" },
	];
	const sides: { name: PricingAnomaly["side"]; pick: (m: { pricing?: RateBlock; originPricing?: RateBlock }) => RateBlock }[] = [
		{ name: "origin", pick: (m) => m.originPricing },
		{ name: "proxy", pick: (m) => m.pricing },
	];

	for (const f of fresh.models ?? []) {
		if (!f.key) continue;
		const prev = prevByKey.get(f.key);
		if (!prev) continue;
		for (const side of sides) {
			const a = side.pick(prev as { pricing?: RateBlock; originPricing?: RateBlock });
			const b = side.pick(f as { pricing?: RateBlock; originPricing?: RateBlock });
			if (!a || !b) continue;
			for (const field of fields) {
				const prevRate = a[field.key];
				const newRate = b[field.key];
				if (typeof prevRate !== "number" || typeof newRate !== "number") continue;
				if (prevRate === 0) continue; // can't compute delta from zero baseline; skip
				if (prevRate === newRate) continue;
				const delta = (newRate - prevRate) / prevRate;
				if (Math.abs(delta) < ANOMALY_DELTA_THRESHOLD) continue;
				anomalies.push({
					ts,
					key: f.key,
					field: field.name,
					side: side.name,
					previous: prevRate,
					current: newRate,
					deltaPct: delta,
					promo: hasPromoFlag(prev) || hasPromoFlag(f),
				});
			}
		}
	}
	return anomalies;
}

/** Append fresh anomalies to <manifestDir>/anomalies.json. Atomic write,
 *  rolling retention (30 days OR last 5000 entries, whichever is tighter). */
async function appendAnomalies(manifestDir: string, fresh: PricingAnomaly[]): Promise<void> {
	const path = join(manifestDir, ANOMALY_FILE);
	const cutoff = Date.now() - ANOMALY_RETENTION_MS;
	let existing: PricingAnomaly[] = [];
	try {
		const { readFile } = await import("fs/promises");
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as { anomalies?: PricingAnomaly[] };
		if (Array.isArray(parsed.anomalies)) existing = parsed.anomalies;
	} catch {
		// missing or unreadable — start fresh
	}
	const all = [...existing, ...fresh].filter((a) => a.ts >= cutoff).slice(-ANOMALY_MAX_ENTRIES);
	const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify({ schemaVersion: 1, anomalies: all }, null, 2), "utf-8");
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

async function discoverProvider(
	state: RegistryState,
	dependencies: DiscoveryDependencies,
	discoverer: ProviderDiscoverer,
	timeout: number,
): Promise<ProviderInfo | null> {
	const breaker = state.healthTracker.breaker(discoverer.providerId);
	const startedAt = Date.now();

	if (!breaker.canExecute()) {
		const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
			state.cache,
			`${CACHE_KEY_PREFIX}${discoverer.providerId}`,
		);
		return stale?.data ?? null;
	}

	const explicitKey = getProviderConfig(state.config, discoverer.providerId)?.apiKey;
	const credential = dependencies.resolveCredential
		? await dependencies.resolveCredential(discoverer.providerId, explicitKey)
		: dependencies.fallbackCredential(discoverer.providerId, explicitKey);

	try {
		const models = await discoverer.discover(credential, { timeout });
		breaker.onSuccess();
		dependencies.recordObservation(discoverer.providerId, {
			latencyMs: Date.now() - startedAt,
			errorType: null,
		});

		return {
			id: discoverer.providerId,
			name: discoverer.providerName,
			baseUrl: discoverer.baseUrl,
			authenticated: credential.source !== "none",
			credentialSource: credential.source,
			models,
			lastRefreshed: Date.now(),
		};
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		breaker.onFailure(errorMessage);
		dependencies.recordObservation(discoverer.providerId, {
			latencyMs: Date.now() - startedAt,
			errorType: dependencies.classifyError(errorMessage),
		});

		const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
			state.cache,
			`${CACHE_KEY_PREFIX}${discoverer.providerId}`,
		);
		if (stale) {
			return stale.data;
		}

		throw error;
	}
}
