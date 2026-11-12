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
import { catalogCacheKey, loadActiveCatalog, resolveCatalogSource } from "./catalog-source.js";
import { buildCatalogOnlyRows } from "./discovery/catalog-only.js";
import { type PriceEvidence, priceAgreement } from "./discovery/price-evidence.js";
import { applyPriceSchedules, SCHEDULED_PRICES } from "./discovery/price-schedules.js";
import { applyPromoOverrides } from "./discovery/promo-overrides.js";
import type { DiscoverySnapshotV1 } from "./discovery-contract.js";
import { DISCOVERY_SCHEMA_VERSION } from "./discovery-contract.js";
import { PRICE_RATE_FIELDS, sanitizeModelPricing } from "./price-trust.js";
import {
	getProviderConfig,
	getProviderDescriptor,
	isLocalProvider,
	normalizeProviderId,
	resolveEnvCredential,
} from "./provider-catalog.js";
import { registryDiscoverySnapshot } from "./registry-discovery.js";
import type { DiscoveryDependencies, RegistryState } from "./registry-state.js";
import { StaleCachePolicy } from "./resilience.js";
import { assertCleanPayload } from "./security.js";
import { getSubscriptionPlan } from "./subscription-plans.js";
import type {
	CredentialResult,
	DiscoveryError,
	DiscoveryOptions,
	Enricher,
	ModelCard,
	ModelPricing,
	ProviderDiscoverer,
	ProviderInfo,
} from "./types.js";

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

/** Providers known only from the public catalog, beside the registry. */
export const CATALOG_ONLY_FILE = "catalog-only.json";

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
			sanitizeRegistryPricing(state);
			if (!providers || providers.length === 0) {
				// A cache hit is not a discovery pass, so it doesn't rewrite the
				// manifest (that would advance missingRunCount and reset price
				// holds on every `kosha list`). It does read the manifest, so a
				// price held there is the price kosha routes and budgets with.
				const manifest = await readPreviousManifest(resolveManifestPath(state));
				if (manifest && applyManifestHolds(state, manifest)) state.lastSnapshotCache = null;
			}
			return Array.from(state.providerMap.values());
		}
	}

	const discoverers = await dependencies.loadDiscoverers(providers, options?.includeLocal);
	const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
	// Providers whose credentialed call failed but which were still listed from
	// the public catalog: the error is reported, the provider is not dropped.
	const degraded: DiscoveryError[] = [];
	const sharedKeys: SharedKeyLedger = { accepted: new Set(), refused: new Map() };
	const results = await Promise.allSettled(
		discoverers.map((discoverer) => discoverProvider(state, dependencies, discoverer, timeout, degraded, sharedKeys)),
	);

	state.lastDiscoveryErrors = [...degraded];
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
	reportRefusedSharedKeys(state, sharedKeys);

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
			models: applyPriceSchedules(applyPromoOverrides(providerInfo.models)).map(sanitizeModelPricing),
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
	const merged = await exportRegistryManifest(state);
	// Quarantine decides in the merge, so carry its verdict back into memory
	// and the cache: kosha's own routing, `cheapest`, MCP and the budget must
	// use the held price, not the suspect one the merge refused.
	if (merged && applyManifestHolds(state, merged)) {
		state.lastSnapshotCache = null;
		await dependencies.saveToCache();
	}
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
		await state.cache.invalidate(catalogCacheKey(`${CACHE_KEY_PREFIX}${normalizedProviderId}`));
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

	const found = resolveEnvCredential(getProviderDescriptor(normalizedProviderId));
	return found
		? { apiKey: found.apiKey, source: "env", envVar: found.envVar, shared: found.shared }
		: { source: "none" };
}

/**
 * Enrich the in-memory model set with pricing metadata when available.
 */
export async function enrichRegistryModels(state: RegistryState): Promise<void> {
	try {
		// LiteLLM is a community catalog, so it enriches only in `community`
		// mode; `pinned` and `local` fill the same gaps from kosha's catalog.
		const catalog = await loadActiveCatalog();
		const { CatalogEnricher, LiteLLMEnricher } = await import("./enrichment/index.js");
		const enricher: Enricher = catalog ? new CatalogEnricher(catalog) : new LiteLLMEnricher();

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
	const allEntry = await state.cache.get<ProviderInfo[]>(catalogCacheKey("providers_all"));
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
			models: applyPriceSchedules(applyPromoOverrides(providerInfo.models)).map(sanitizeModelPricing),
		});
	}
	attributePricingSources(state, preEnrichmentPriced);
	populateRegistryModelAliases(state);
	await saveRegistryToCache(state);
	const merged = await exportRegistryManifest(state);
	if (merged && applyManifestHolds(state, merged)) {
		state.lastSnapshotCache = null;
		await saveRegistryToCache(state);
	}

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
	return !!pricing && pricing.inputPerMillion !== undefined && pricing.outputPerMillion !== undefined;
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
				model.pricingSource = fromDiscovery ? (model.source === "api" ? "provider-live" : "static-seed") : "litellm";
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
		const allEntry = await state.cache.get<ProviderInfo[]>(catalogCacheKey("providers_all"));
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
		const entry = await state.cache.get<ProviderInfo>(catalogCacheKey(`${CACHE_KEY_PREFIX}${providerId}`));
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
		const saves = providers.map((provider) =>
			state.cache.set(catalogCacheKey(`${CACHE_KEY_PREFIX}${provider.id}`), provider),
		);
		saves.push(state.cache.set(catalogCacheKey("providers_all"), providers));
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
export async function exportRegistryManifest(
	state: RegistryState,
	options?: { catalogOnly?: boolean },
): Promise<DiscoverySnapshotV1 | null> {
	let manifestPath: string | null = null;
	let lockReleased = true;
	let lockPath: string | null = null;
	let fresh: DiscoverySnapshotV1 | null = null;
	let merged: DiscoverySnapshotV1 | null = null;
	try {
		fresh = state.lastSnapshotCache ?? registryDiscoverySnapshot(state);
		state.lastSnapshotCache = fresh;
		// Honour state.config.cacheDir so isolated tests (and any other caller
		// that pins a custom cache root) don't clobber the user's real
		// ~/.kosha/registry.json. Without this, running the kosha test suite
		// silently overwrote the user's manifest with an empty one because
		// every test instance triggered an export against the hardcoded path.
		manifestPath = resolveManifestPath(state);
		await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });

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
		merged = mergeManifests(previousManifest, fresh);

		// Pricing-diff alerts. The most dangerous failure mode isn't "kosha
		// returned null" (we already detect that). It's "kosha returned a
		// wrong number" — silent over- or undercharging. We compare prev vs
		// fresh rates per model and append anomalies (>25% delta) to a
		// rolling 30-day log. Best-effort — never fails the export.
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

		// Atomic write: temp file in the same directory, then rename(2).
		// `rename` within a single filesystem is atomic on POSIX and
		// preserves any concurrent reader's existing fd. Without this, a
		// reader (e.g. tokmeter's pricing manifest fallback) can land mid
		// `JSON.stringify` write and parse a truncated file. The tmp suffix
		// uses 8 random hex chars so two concurrent kosha updates don't
		// collide on the staging name.
		const tmpPath = `${manifestPath}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(tmpPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
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
		warnOnNewlyDisputedPrices(previousManifest, merged);
		if (options?.catalogOnly !== false)
			await exportCatalogOnlyManifest(manifestPath, new Set(state.providerMap.keys()));
		return merged;
	} catch (err) {
		// Manifest export is best-effort — the cache still works either way.
		// But silent failure was making permission/disk-full bugs invisible
		// for days. Surface the reason once via stderr; nothing else is
		// gated on a successful export.
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(`[kosha] manifest export failed (${manifestPath ?? "unknown path"}): ${reason}`);
		// The write failed, but the price verdicts must not: compute the merge in
		// memory so the caller still applies its holds. Without this a lock
		// timeout or a full disk let a suspect price straight into routing.
		if (!merged && fresh) {
			try {
				const previous = manifestPath ? await readPreviousManifest(manifestPath) : null;
				merged = mergeManifests(previous, fresh);
			} catch {
				// Nothing left to judge against; the caller keeps what it has.
			}
		}
		return merged;
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

		// Only rotate if today's bak slot is empty and the manifest exists.
		// Checked in this order — cheap slot check before the read — so a
		// taken slot short-circuits without touching the manifest at all.
		try {
			await stat(todayBak);
			return; // today's slot already taken — first writer of the day wins
		} catch {
			// fall through — slot is free
		}

		// Copy the current manifest to today's bak slot. We copy rather than
		// rename so the live manifest stays in place during the gap between
		// rotation and the new rename(2) below.
		//
		// Read directly instead of stat()-then-readFile() on the path: a
		// stat() that only confirms existence adds a check-then-use gap
		// (CodeQL js/file-system-race) for no benefit, since the read below
		// has to handle a missing/racing file anyway. Attempting the read and
		// treating ENOENT as "nothing to back up" removes the gap outright.
		const { readFile } = await import("fs/promises");
		let data: Buffer;
		try {
			data = await readFile(manifestPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return; // no current manifest, nothing to back up
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

/** A price held or changed while its sources disagree is only worth anything if
 *  someone hears about it, so say so once, when a model first enters that state. */
function warnOnNewlyDisputedPrices(previous: DiscoverySnapshotV1 | null, merged: DiscoverySnapshotV1): void {
	const disputed = (snapshot: DiscoverySnapshotV1 | null) =>
		(snapshot?.models ?? []).filter((m) => m.rawCapabilities?.includes(PRICING_SOURCES_DISAGREE)).map((m) => m.key);
	const known = new Set(disputed(previous));
	const fresh = disputed(merged).filter((key) => !known.has(key));
	if (fresh.length > 0) {
		console.warn(`[kosha] ${fresh.length} price(s) where sources disagree, e.g. ${fresh[0]}`);
	}
}

/** Refuse to write more than this: the catalog itself caps providers and models,
 *  so a file this large means something upstream went wrong. */
const MAX_CATALOG_ONLY_BYTES = 32 * 1024 * 1024;

/**
 * Save providers known only from the public catalog to their own file beside
 * the registry. They stay out of `registry.json` and the provider cache so no
 * reader, however old, can route to one or match a model name against one.
 * Readers ask this file for one named provider. Goes through the same merge,
 * so a bad publish is held here as it is anywhere else.
 *
 * Failing leaves the previous file in place: the registry above is already saved.
 */
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

/** Tags the manifest merge puts on a price that isn't settled. */
const PRICE_HOLD_TAGS = ["pricing_quarantined", "pricing_sources_disagree", "pricing_single_source"];

/** Run {@link sanitizeModelPricing} over every model in memory. */
function sanitizeRegistryPricing(state: RegistryState): void {
	for (const [providerId, providerInfo] of state.providerMap) {
		const models = providerInfo.models.map(sanitizeModelPricing);
		if (models.some((m, i) => m !== providerInfo.models[i]))
			state.providerMap.set(providerId, { ...providerInfo, models });
	}
}

/**
 * Copy the merge's price verdicts onto the in-memory registry. A quarantined
 * row carries the held (previous) price, which replaces the suspect one in
 * memory; dispute and single-source flags are copied onto rawCapabilities so
 * every reader sees them. Rows the manifest kept for a model this run didn't
 * see are ignored. Returns true when anything in memory changed.
 */
export function applyManifestHolds(state: RegistryState, manifest: DiscoverySnapshotV1): boolean {
	const rows = new Map<string, DiscoverySnapshotV1["models"][number]>();
	for (const row of manifest.models ?? []) {
		if ((row.rawCapabilities ?? []).some((tag) => PRICE_HOLD_TAGS.includes(tag))) {
			rows.set(`${row.providerId}\u0000${row.modelId}`, row);
		}
	}
	if (rows.size === 0) return false;
	let changed = false;
	for (const [providerId, providerInfo] of state.providerMap) {
		let touched = false;
		const models = providerInfo.models.map((model) => {
			const row = rows.get(`${providerId}\u0000${model.id}`);
			if (!row) return model;
			const next: ModelCard = { ...model };
			let tags = model.rawCapabilities ?? [];
			for (const tag of PRICE_HOLD_TAGS) {
				if ((row.rawCapabilities ?? []).includes(tag) && !tags.includes(tag)) tags = [...tags, tag];
			}
			let differs = tags !== (model.rawCapabilities ?? []);
			if (tags.length > 0) next.rawCapabilities = tags;
			const quarantined = (row.rawCapabilities ?? []).includes("pricing_quarantined");
			const disputed = (row.rawCapabilities ?? []).includes(PRICING_SOURCES_DISAGREE);
			if (quarantined || disputed) {
				// While a price is held or disputed, kosha routes and budgets on the
				// highest rate anyone reported: the held one, the fresh one and each
				// source's. Overpaying in the estimate is safe; undercounting isn't.
				const base = quarantined ? (row.pricing ?? null) : (model.pricing ?? null);
				const evidence = model.priceEvidence ?? row.priceEvidence ?? [];
				const held = base
					? (sanitizeModelPricing({ ...model, pricing: highestRates(base, model.pricing ?? null, evidence) }).pricing ??
						null)
					: null;
				if (JSON.stringify(held) !== JSON.stringify(model.pricing ?? null)) {
					differs = true;
					if (held) next.pricing = held;
					else delete next.pricing;
				}
				if (quarantined && JSON.stringify(row.originPricing ?? null) !== JSON.stringify(model.originPricing ?? null)) {
					differs = true;
					if (row.originPricing) next.originPricing = row.originPricing;
					else delete next.originPricing;
				}
			}
			if (!differs) return model;
			touched = true;
			return next;
		});
		if (touched) {
			state.providerMap.set(providerId, { ...providerInfo, models });
			changed = true;
		}
	}
	return changed;
}

/** Each rate at the highest of `base`, `other` and the sources' headline
 *  rates. Fields `base` doesn't price stay unpriced. */
function highestRates(base: ModelPricing, other: ModelPricing | null, evidence: PriceEvidence[]): ModelPricing {
	const out: Record<string, unknown> = { ...base };
	for (const field of QUARANTINE_FIELDS) {
		const current = out[field];
		if (typeof current !== "number") continue;
		let highest = current;
		const fresh = (other as Record<string, unknown> | null)?.[field];
		if (typeof fresh === "number" && Number.isFinite(fresh)) highest = Math.max(highest, fresh);
		if (field === "inputPerMillion" || field === "outputPerMillion") {
			for (const entry of evidence) {
				if (Number.isFinite(entry[field])) highest = Math.max(highest, entry[field]);
			}
		}
		out[field] = highest;
	}
	return out as unknown as ModelPricing;
}

/** What `kosha registry accept` found for a model. */
export type AcceptHeldPriceResult =
	| { status: "accepted"; held: ModelPricing | null; waitingSince: number }
	| { status: "not-held" }
	| { status: "not-found" };

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
	const lockPath = `${manifestPath}.lock`;
	await acquireExportLock(lockPath);
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
		await unlink(lockPath).catch(() => {});
	}
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
	const current = await readManifestFile(manifestPath);
	if (current) return current;
	// The manifest holds every price baseline. Losing it to a corrupt write, a
	// schema bump or a failed scan would accept every fresh price unchecked, so
	// fall back to the newest readable backup in the rollback ring.
	for (const backup of await listBackups(manifestPath)) {
		const parsed = await readManifestFile(backup);
		if (parsed) return parsed;
	}
	return null;
}

async function readManifestFile(path: string): Promise<DiscoverySnapshotV1 | null> {
	try {
		const { readFile } = await import("fs/promises");
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as DiscoverySnapshotV1;
		if (!parsed?.models) return null;
		// Schema-version guard. A different version on disk means we can't
		// trust the field shapes.
		if (parsed.schemaVersion !== DISCOVERY_SCHEMA_VERSION) return null;
		assertCleanPayload(parsed, "registry manifest");
		return parsed;
	} catch {
		return null; // missing or unreadable
	}
}

/** The manifest's `.bak.<YYYY-MM-DD>` copies, newest first. */
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

/** Beyond this fractional rate change in either direction, we treat a fresh
 *  price as suspect and keep the previous value (quarantine). The 25% delta
 *  used by anomaly logging is a UI-alert threshold; quarantine fires only on
 *  a much larger swing so legitimate price updates aren't blocked. */
const PRICING_QUARANTINE_THRESHOLD = 0.75;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Quarantine guards against a bad publish, but a real move must not stay refused
 *  forever. Two independent sources agreeing is strong evidence, so that's a day. */
const PRICING_AGREED_HOLD_MS = DAY_MS;

/** One source can't vouch for itself, and a compromised one can simply wait out
 *  the hold. So it waits longer, and the row stays flagged once it's accepted. */
const PRICING_SINGLE_SOURCE_HOLD_MS = 3 * DAY_MS;

/** Sources can stay apart for good: one going stale after a real move would
 *  otherwise pin the old price forever. So a dispute waits longest, and the row
 *  stays flagged once it's accepted. */
const PRICING_DISPUTED_HOLD_MS = 7 * DAY_MS;

/** The accepted price rests on one source's word. */
const PRICING_SINGLE_SOURCE = "pricing_single_source";

/** Sources list different prices for this model. */
const PRICING_SOURCES_DISAGREE = "pricing_sources_disagree";

/** A previously-known model missing from fresh snapshots for longer than this
 *  is dropped from the merged manifest. Prevents the manifest from becoming a
 *  graveyard of deprecated SKUs while still riding through outages. */
const MISSING_MODEL_TTL_MS = 30 * DAY_MS;

export function mergeManifests(previous: DiscoverySnapshotV1 | null, fresh: DiscoverySnapshotV1): DiscoverySnapshotV1 {
	if (!previous) return fresh;

	// Index previous entries by key so we can both detect collisions AND
	// look back at the old data for pricing-degraded merge below.
	const previousByKey = new Map<string, (typeof previous.models)[number]>();
	for (const m of previous.models) {
		if (m.key) previousByKey.set(m.key, m);
	}

	// Per-model merge with three rules:
	//   (1) Old entries fresh dropped entirely → keep until unseen for
	//       MISSING_MODEL_TTL_MS (model lifecycle TTL).
	//   (2) Fresh entries that came back with NO pricing while the old entry
	//       HAD pricing → keep the old pricing block (degraded-fresh defence).
	//   (3) Fresh entries whose rates moved beyond PRICING_QUARANTINE_THRESHOLD
	//       → keep the previous pricing and tag the row pricing_quarantined,
	//       so a one-shot bad publish (provider returns 0, garbage units, …)
	//       can't silently overcharge or underprice downstream consumers.
	//       The same rates are accepted after a day if two sources agree on them,
	//       after three days if only one lists them, and not while sources disagree.
	const now = fresh.discoveredAt ?? Date.now();
	const freshModelKeys = new Set<string>();
	const mergedModels: (typeof fresh.models)[number][] = [];
	for (const f of fresh.models ?? []) {
		if (f.key) freshModelKeys.add(f.key);
		const old = f.key ? previousByKey.get(f.key) : undefined;

		let kept = { ...f, missingRunCount: 0, lastSeenAt: now } as (typeof fresh.models)[number] & {
			missingRunCount?: number;
		};
		// A secondary rate (cache, audio, image…) that falls from a price to 0
		// reads as "not reported" in the catalogs, but billing it at 0 would
		// undercount spend. Keep the last real rate instead.
		if (old) kept = keepReportedSecondaryRates(old, kept);
		if (old && !hasUsablePricing(f) && hasUsablePricing(old)) {
			// Keep all of fresh's metadata but restore pricing from old.
			kept = { ...kept, pricing: old.pricing, originPricing: old.originPricing };
		} else if (old && !isCuratedSchedule(f) && quarantinePricingMove(old, kept)) {
			// A scheduled price is curated and cited, not a catalog's publish, so
			// it skips quarantine. Otherwise the first move to it would be refused
			// on every run. Only kosha's own schedule table counts: a `schedule`
			// field carried in by a snapshot or a local file proves nothing.
			const rates = pricingFingerprint(kept);
			const hold = (old as { pricingHold?: PricingHold }).pricingHold;
			const same = hold !== undefined && (hold.rates === rates || hold.rates === legacyPricingFingerprint(kept));
			const since = same ? hold.since : now;
			const accepted = same && hold.accepted === true;
			const agreement = priceAgreement((f as { priceEvidence?: PriceEvidence[] }).priceEvidence);
			const window =
				agreement === "agree"
					? PRICING_AGREED_HOLD_MS
					: agreement === "disagree"
						? PRICING_DISPUTED_HOLD_MS
						: PRICING_SINGLE_SOURCE_HOLD_MS;
			// A billed rate that collapses to $0, or to under 1% of what it was, is
			// never accepted by waiting: it poisons cheapest routing however long
			// it's published. Only `kosha registry accept` releases it.
			if (!accepted && (billedRateCollapsed(old, kept) || now - since < window)) {
				// Quarantine the suspect rates: keep the old pricing block and
				// tag the operational `rawCapabilities` array (the trusted
				// `capabilities` taxonomy stays clean, since this isn't a routing
				// signal — it's a "don't trust the freshly-published rate" flag).
				let tags = tagCapability(kept.rawCapabilities, "pricing_quarantined");
				if (agreement === "disagree") tags = tagCapability(tags, PRICING_SOURCES_DISAGREE);
				kept = {
					...kept,
					pricing: old.pricing,
					originPricing: old.originPricing,
					rawCapabilities: tags,
					pricingHold: { rates, since },
				} as typeof kept;
			} else if (agreement !== "agree") {
				const flag = agreement === "single" ? PRICING_SINGLE_SOURCE : PRICING_SOURCES_DISAGREE;
				kept = { ...kept, rawCapabilities: tagCapability(kept.rawCapabilities, flag) };
			}
		} else if (old && !isCuratedSchedule(f)) {
			// Below the quarantine line a price still takes effect, but a move its
			// sources dispute is the believable lie, so it carries a flag. Flags
			// from an earlier move last until the rates change or the evidence does.
			const agreement = priceAgreement((f as { priceEvidence?: PriceEvidence[] }).priceEvidence);
			const moved = pricingFingerprint(old) !== pricingFingerprint(f);
			const wasTagged = (tag: string) => !moved && (old.rawCapabilities ?? []).includes(tag);
			let tags = kept.rawCapabilities;
			if (agreement === "disagree" && (moved || wasTagged(PRICING_SOURCES_DISAGREE))) {
				tags = tagCapability(tags, PRICING_SOURCES_DISAGREE);
			}
			if (agreement === "single" && wasTagged(PRICING_SINGLE_SOURCE)) {
				tags = tagCapability(tags, PRICING_SINGLE_SOURCE);
			}
			if (tags !== kept.rawCapabilities) kept = { ...kept, rawCapabilities: tags };
		}
		mergedModels.push(kept);
	}
	for (const old of previous.models) {
		if (!old.key || freshModelKeys.has(old.key)) continue;
		const prevMissing = (old as { missingRunCount?: number }).missingRunCount ?? 0;
		// The row is the baseline a returning model's price is checked against,
		// so it ages by time, not by how often discovery ran: an hourly loop
		// would otherwise drop it in under a day. Rows written before lastSeenAt
		// existed date from the previous run.
		const lastSeenAt = (old as { lastSeenAt?: number }).lastSeenAt ?? previous.discoveredAt ?? now;
		if (now - lastSeenAt > MISSING_MODEL_TTL_MS) continue; // drop after TTL
		mergedModels.push({ ...old, missingRunCount: prevMissing + 1, lastSeenAt } as typeof old);
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

/** The rates a quarantined row is waiting on, when they were first seen, and
 *  whether someone accepted them with `kosha registry accept`. */
interface PricingHold {
	rates: string;
	since: number;
	accepted?: boolean;
}

type PricedSides = { pricing?: unknown; originPricing?: unknown };
type Rates = Record<string, unknown> | null | undefined;

/** Every rate that bills or ranks. The long-context threshold is a token
 *  count, not a price, so it isn't compared. */
const QUARANTINE_FIELDS = PRICE_RATE_FIELDS.filter((field) => field !== "longContextThresholdTokens");

/** The billed rates that decide a model's headline price. */
const HEADLINE_FIELDS = new Set<string>(["inputPerMillion", "outputPerMillion"]);

/** A billed rate below this share of the one it replaces counts as a collapse,
 *  like $0: never accepted by waiting. */
const PRICING_COLLAPSE_RATIO = 0.01;

function pricingFingerprint(model: PricedSides): string {
	return JSON.stringify(
		[model.pricing, model.originPricing].map((side) =>
			QUARANTINE_FIELDS.map((field) => (side as Rates)?.[field] ?? null),
		),
	);
}

/** The five-field fingerprint holds recorded before every rate was compared.
 *  Matching it keeps an upgrade from restarting every hold's clock. */
function legacyPricingFingerprint(model: PricedSides): string {
	const fields = [
		"inputPerMillion",
		"outputPerMillion",
		"cacheReadPerMillion",
		"cacheWritePerMillion",
		"cacheWrite1hPerMillion",
	];
	return JSON.stringify(
		[model.pricing, model.originPricing].map((side) => fields.map((field) => (side as Rates)?.[field] ?? null)),
	);
}

/** True when the fresh row's pricing is kosha's own cited schedule for that model. */
function isCuratedSchedule(row: DiscoverySnapshotV1["models"][number]): boolean {
	if (!row.pricing?.schedule) return false;
	const match = SCHEDULED_PRICES.find((s) => s.providerId === row.providerId && s.modelId === row.modelId);
	return (
		match !== undefined &&
		row.pricing.inputPerMillion === match.peak.inputPerMillion &&
		row.pricing.outputPerMillion === match.peak.outputPerMillion
	);
}

/** Restore a secondary billed rate that went from a price to 0. */
function keepReportedSecondaryRates<T extends PricedSides>(previous: PricedSides, fresh: T): T {
	const a = previous.pricing as Rates;
	const b = fresh.pricing as Rates;
	if (!a || !b) return fresh;
	let pricing: Record<string, unknown> | null = null;
	for (const field of QUARANTINE_FIELDS) {
		if (HEADLINE_FIELDS.has(field)) continue;
		const prev = a[field];
		if (typeof prev === "number" && prev > 0 && b[field] === 0) {
			pricing ??= { ...b };
			pricing[field] = prev;
		}
	}
	return pricing ? { ...fresh, pricing } : fresh;
}

/** True if a billed rate fell to zero (input or output) or to under 1% of the
 *  rate it replaces (any field). */
function billedRateCollapsed(previous: PricedSides, fresh: PricedSides): boolean {
	const a = previous.pricing as Rates;
	const b = fresh.pricing as Rates;
	if (!a || !b) return false;
	return QUARANTINE_FIELDS.some((field) => {
		const prev = a[field];
		const next = b[field];
		if (typeof prev !== "number" || typeof next !== "number" || prev <= 0) return false;
		if (next === 0) return HEADLINE_FIELDS.has(field);
		return next < prev * PRICING_COLLAPSE_RATIO;
	});
}

/** True if any defined rate moved by more than the quarantine threshold
 *  (either direction), compared to the previous snapshot. */
function quarantinePricingMove(previous: PricedSides, fresh: PricedSides): boolean {
	if (billedRateCollapsed(previous, fresh)) return true;
	for (const side of ["pricing", "originPricing"] as const) {
		const a = (previous[side] as Rates) ?? null;
		const b = (fresh[side] as Rates) ?? null;
		if (!a || !b) continue;
		for (const field of QUARANTINE_FIELDS) {
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
	/** Which rate moved: `input`, `output`, `cacheRead`, `cacheWrite`, `cacheWrite1h`. */
	field: "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h";
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

function detectPricingAnomalies(previous: DiscoverySnapshotV1 | null, fresh: DiscoverySnapshotV1): PricingAnomaly[] {
	if (!previous?.models) return [];
	const prevByKey = new Map<string, (typeof previous.models)[number]>();
	for (const m of previous.models) {
		if (m.key) prevByKey.set(m.key, m);
	}
	const ts = Date.now();
	const anomalies: PricingAnomaly[] = [];

	type RateBlock =
		| {
				inputPerMillion?: number;
				outputPerMillion?: number;
				cacheReadPerMillion?: number;
				cacheWritePerMillion?: number;
				cacheWrite1hPerMillion?: number;
		  }
		| null
		| undefined;
	const fields: { name: PricingAnomaly["field"]; key: keyof NonNullable<RateBlock> }[] = [
		{ name: "input", key: "inputPerMillion" },
		{ name: "output", key: "outputPerMillion" },
		{ name: "cacheRead", key: "cacheReadPerMillion" },
		{ name: "cacheWrite", key: "cacheWritePerMillion" },
		{ name: "cacheWrite1h", key: "cacheWrite1hPerMillion" },
	];
	const sides: {
		name: PricingAnomaly["side"];
		pick: (m: { pricing?: RateBlock; originPricing?: RateBlock }) => RateBlock;
	}[] = [
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

/**
 * Drop anomalies the log already ends on. A quarantined rate keeps the old
 * price in the manifest, so every export sees the same move again; logging
 * each one printed the same 172 lines on every run and pushed real changes
 * out of the capped log. A price that moves away and back is still logged.
 */
export function unloggedAnomalies(existing: PricingAnomaly[], fresh: PricingAnomaly[]): PricingAnomaly[] {
	const latest = new Map<string, PricingAnomaly>();
	const id = (a: PricingAnomaly) => `${a.key}|${a.side}|${a.field}`;
	for (const a of existing) latest.set(id(a), a);
	return fresh.filter((a) => {
		const last = latest.get(id(a));
		return !last || last.previous !== a.previous || last.current !== a.current;
	});
}

/** Append new anomalies to <manifestDir>/anomalies.json and return how many
 *  there were. Atomic write, rolling retention (30 days OR last 5000 entries,
 *  whichever is tighter). */
async function appendAnomalies(manifestDir: string, detected: PricingAnomaly[]): Promise<number> {
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
	const fresh = unloggedAnomalies(existing, detected);
	if (fresh.length === 0) return 0;
	const all = [...existing, ...fresh].filter((a) => a.ts >= cutoff).slice(-ANOMALY_MAX_ENTRIES);
	const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify({ schemaVersion: 1, anomalies: all }, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
	return fresh.length;
}

async function discoverProvider(
	state: RegistryState,
	dependencies: DiscoveryDependencies,
	discoverer: ProviderDiscoverer,
	timeout: number,
	degraded: DiscoveryError[],
	sharedKeys: SharedKeyLedger,
): Promise<ProviderInfo | null> {
	const breaker = state.healthTracker.breaker(discoverer.providerId);
	const startedAt = Date.now();

	if (!breaker.canExecute()) {
		const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
			state.cache,
			catalogCacheKey(`${CACHE_KEY_PREFIX}${discoverer.providerId}`),
		);
		return stale?.data ?? null;
	}

	const explicitKey = getProviderConfig(state.config, discoverer.providerId)?.apiKey;
	const credential = dependencies.resolveCredential
		? await dependencies.resolveCredential(discoverer.providerId, explicitKey)
		: dependencies.fallbackCredential(discoverer.providerId, explicitKey);
	// A plan is listed only for someone holding a key to it; without one its
	// models stay price-only rows in catalog-only.json.
	const isPlan = getProviderDescriptor(discoverer.providerId)?.subscriptionPlan === true;
	if (isPlan && (credential.source === "none" || state.config.keyless)) return null;

	try {
		// Cloud discoverers fall back to ambient credentials (the AWS chain, gcloud)
		// whatever credential they're given, so keyless mode has its own path there.
		const keylessPath = state.config.keyless ? discoverer.discoverKeyless?.bind(discoverer) : undefined;
		const models = keylessPath ? await keylessPath() : await discoverer.discover(credential, { timeout });
		breaker.onSuccess();
		dependencies.recordObservation(discoverer.providerId, {
			latencyMs: Date.now() - startedAt,
			errorType: null,
		});
		if (credential.shared && credential.envVar) sharedKeys.accepted.add(credential.envVar);

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
		// A key borrowed from a shared env var (QWEN_API_KEY read by Alibaba's
		// regions and plans) is expected to be refused by the siblings it isn't
		// for. That is no fault of this provider, so no breaker failure and no
		// warning here; only a key every reader refuses gets reported, once.
		if (credential.shared && credential.envVar && isTentativeKeyMiss(error)) {
			if (!isPlanKeyUnverified(error)) {
				const refusers = sharedKeys.refused.get(credential.envVar) ?? [];
				refusers.push(discoverer.providerId);
				sharedKeys.refused.set(credential.envVar, refusers);
			}
			if (isPlan) return null;
			return listedWithoutKey(state, discoverer, timeout);
		}
		breaker.onFailure(errorMessage);
		dependencies.recordObservation(discoverer.providerId, {
			latencyMs: Date.now() - startedAt,
			errorType: dependencies.classifyError(errorMessage),
		});

		const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
			state.cache,
			catalogCacheKey(`${CACHE_KEY_PREFIX}${discoverer.providerId}`),
		);
		if (stale) {
			// Serving yesterday's listing is right; serving it silently is not.
			// A key rejected today otherwise looks healthy for as long as the
			// old cache lasts. A keyless failure (a local runtime that isn't
			// up) stays quiet, as it always has.
			if (credential.source === "none") return stale.data;
			degraded.push({
				providerId: discoverer.providerId,
				providerName: discoverer.providerName,
				error: errorMessage,
				timestamp: Date.now(),
			});
			return { ...stale.data, degradedReason: errorMessage, degradedSource: "cache" };
		}

		// A rejected or unreachable credentialed call says nothing about what
		// the provider serves or charges — that is public. Without this, one
		// expired key (or a China-region key tried against the international
		// host) removed the provider's whole catalog from routing and pricing.
		// The failure is still recorded, and the provider is reported as
		// unauthenticated, because that is what it effectively is.
		if (credential.source !== "none") {
			try {
				const models = await discoverer.discover({ source: "none" }, { timeout });
				if (models.length > 0) {
					degraded.push({
						providerId: discoverer.providerId,
						providerName: discoverer.providerName,
						error: errorMessage,
						timestamp: Date.now(),
					});
					return {
						id: discoverer.providerId,
						name: discoverer.providerName,
						baseUrl: discoverer.baseUrl,
						authenticated: false,
						credentialSource: "none",
						models,
						lastRefreshed: Date.now(),
						degradedReason: errorMessage,
						degradedSource: "catalog",
					};
				}
			} catch {
				/* the keyless path failed too — report the original error */
			}
		}

		throw error;
	}
}

/** Which shared env vars some provider accepted, and who refused each. */
interface SharedKeyLedger {
	accepted: Set<string>;
	refused: Map<string, string[]>;
}

/** Matched by name: the discovery modules load lazily, so no class import here. */
function isPlanKeyUnverified(error: unknown): boolean {
	return error instanceof Error && error.name === "PlanKeyUnverifiedError";
}

/** A 401/403, or a plan with no list to test the key on. A timeout is neither. */
function isTentativeKeyMiss(error: unknown): boolean {
	if (isPlanKeyUnverified(error)) return true;
	return error instanceof Error && /API error:\s*40[13]\b/.test(error.message);
}

/**
 * The provider's public listing, used when a shared key turned out not to be
 * its key. Quiet: the provider is fine, the key belongs to a sibling.
 */
async function listedWithoutKey(
	state: RegistryState,
	discoverer: ProviderDiscoverer,
	timeout: number,
): Promise<ProviderInfo | null> {
	try {
		const models = await discoverer.discover({ source: "none" }, { timeout });
		if (models.length > 0) {
			return {
				id: discoverer.providerId,
				name: discoverer.providerName,
				baseUrl: discoverer.baseUrl,
				authenticated: false,
				credentialSource: "none",
				models,
				lastRefreshed: Date.now(),
			};
		}
	} catch {
		/* fall back to the last good listing */
	}
	const stale = await StaleCachePolicy.getWithStale<ProviderInfo>(
		state.cache,
		catalogCacheKey(`${CACHE_KEY_PREFIX}${discoverer.providerId}`),
	);
	return stale ? { ...stale.data, authenticated: false, credentialSource: "none" } : null;
}

/**
 * One warning per shared env var no provider accepted. It goes on each
 * listed provider that refused it, so `update` and `doctor` show it, and
 * names every host that said no.
 */
function reportRefusedSharedKeys(state: RegistryState, ledger: SharedKeyLedger): void {
	for (const [envVar, refusers] of ledger.refused) {
		if (ledger.accepted.has(envVar)) continue;
		const families = new Set(refusers.map((id) => getSubscriptionPlan(id)?.family ?? id));
		const hint = families.has("alibaba")
			? " If it is an Alibaba Coding Plan key, set ALIBABA_CODING_PLAN_API_KEY instead: that host can't test a key."
			: "";
		const message = `${envVar} was refused by every provider that reads it: ${refusers.join(", ")} (API error: 401).${hint}`;
		for (const id of refusers) {
			const provider = state.providerMap.get(id);
			if (provider) state.providerMap.set(id, { ...provider, degradedReason: message, degradedSource: "catalog" });
		}
		state.lastDiscoveryErrors.push({
			providerId: refusers[0],
			providerName: envVar,
			error: message,
			timestamp: Date.now(),
		});
	}
}
