/**
 * cli-commands.ts — Command implementations for the kosha CLI.
 *
 * Each exported `cmd*` function corresponds to a top-level CLI sub-command.
 * Formatting utilities are imported from `./cli-format.js` to keep
 * presentation logic separate from command orchestration.
 *
 * This module also serves as the barrel re-export for commands that were
 * split into dedicated files (`cli-cmd-model.ts`, `cli-cmd-query.ts`,
 * `cli-help.ts`) to keep each file under 450 LOC.
 *
 * @module cli-commands
 */

import type { ModelMode, ProviderInfo } from "./types.js";
import type { ModelRegistry } from "./registry.js";
import {
	BOLD, CYAN, DIM, GREEN, RED, YELLOW,
	c, formatContextWindow, formatPrice, formatRelativeTime, formatTimestamp,
	line, renderTable,
} from "./cli-format.js";
import type { Column } from "./cli-format.js";

// ---------------------------------------------------------------------------
//  Shared helpers — exported so split modules can import them
// ---------------------------------------------------------------------------

/**
 * Standard column layout reused by both `cmdList` and `cmdSearch`.
 * Extracted to avoid duplicating the same six-column definition.
 */
export const MODEL_TABLE_COLUMNS: Column[] = [
	{ header: "Provider", width: 12 },
	{ header: "Model", width: 38 },
	{ header: "Mode", width: 10 },
	{ header: "Context", width: 10 },
	{ header: "$/M in", width: 8, align: "right" },
	{ header: "$/M out", width: 8, align: "right" },
];

/**
 * Return a human-readable label for a provider's credential source.
 * Providers that need no remote auth (e.g. local Ollama) show `"none (local)"`.
 *
 * @param provider  The provider info object.
 * @returns         A short label suitable for table display.
 */
export function formatCredentialSource(provider: ProviderInfo): string {
	if (!provider.credentialSource || provider.credentialSource === "none") {
		return c(DIM, "none (local)");
	}
	return `${provider.credentialSource}`;
}

/**
 * Ensure the registry has at least one provider loaded.
 *
 * The registry's `discover()` transparently hydrates from the on-disk cache
 * at `~/.kosha/cache` when that cache is still within TTL, and only hits
 * provider APIs on a cold start or a stale cache. I look at the resulting
 * `discoveredAt` timestamp to tell the user which path actually ran — the
 * old "No cached data. Running discovery..." message was misleading because
 * it fired on every invocation regardless of whether the cache was used.
 *
 * Honesty here matters: users need to trust that `kosha list` is fast
 * because the cache exists, and that `kosha update` is the way to refresh.
 *
 * @param registry  The shared model registry instance.
 */
export async function ensureDiscovered(registry: ModelRegistry): Promise<void> {
	if (registry.providers_list().length > 0) return;

	const beforeMs = Date.now();
	await registry.discover();
	const { discoveredAt } = registry.toJSON();
	const providers = registry.providers_list();
	const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);

	// If the timestamp on the hydrated registry is older than "basically now",
	// we know the disk cache was loaded rather than a live discovery running.
	const usedCache = discoveredAt > 0 && beforeMs - discoveredAt > 2_000;

	if (usedCache) {
		const age = formatRelativeTime(discoveredAt, beforeMs);
		console.log(c(DIM,
			`Loaded ${totalModels} models from cache (${age}). Run "kosha update" to refresh.`,
		));
	} else {
		console.log(c(DIM,
			`Discovered ${totalModels} models from ${providers.length} providers.`,
		));
		console.log(c(DIM,
			`Saved to ~/.kosha/cache and exported manifest to ~/.kosha/registry.json`,
		));
	}
}

/**
 * Build a model-table row from a model card (shared by list/search).
 * @param m  A model card object.
 * @returns  An array of formatted cell strings.
 */
export function modelRow(m: { provider: string; id: string; mode: string; contextWindow: number; pricing?: { inputPerMillion: number; outputPerMillion: number } }): string[] {
	return [
		c(CYAN, m.provider), m.id, m.mode,
		formatContextWindow(m.contextWindow),
		formatPrice(m.pricing?.inputPerMillion),
		formatPrice(m.pricing?.outputPerMillion),
	];
}

export function parseNumberFlag(value: string | boolean | undefined): number | undefined {
	if (typeof value !== "string") return undefined;
	const n = Number(value);
	if (!Number.isFinite(n)) return undefined;
	return n;
}

/** Print a provider summary line (used by discover & refresh). */
function printProviderSummary(providers: ProviderInfo[]): void {
	let totalModels = 0;
	for (const p of providers) {
		totalModels += p.models.length;
		// Three-state indicator: green ✓ if models found, yellow ○ if no creds but
		// provider is optional (e.g. Ollama not running), red ✗ if auth required but missing
		const status = p.models.length > 0
			? c(GREEN, "\u2713")
			: p.credentialSource === "none"
				? c(YELLOW, "\u25CB")
				: c(RED, "\u2717");
		const hint = p.models.length === 0 && p.credentialSource !== "none" && !p.authenticated
			? c(DIM, " (no credentials)")
			: p.models.length === 0 && p.credentialSource === "none"
				? c(DIM, " (not running)")
				: "";
		console.log(`  ${status} ${c(CYAN, p.name)}: ${p.models.length} models${hint}`);
	}
	console.log(c(DIM, "\n" + line("\u2500", 50)));
	console.log(`${c(BOLD, String(totalModels))} models from ${c(BOLD, String(providers.length))} providers`);
}

// ── discover ─────────────────────────────────────────────────────────────

/**
 * Discover all configured providers and print a summary.
 * With `--json` the entire registry snapshot is emitted as JSON.
 *
 * @param registry  The model registry to discover into.
 * @param flags     CLI flags (supports `--json`).
 */
export async function cmdDiscover(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	console.log(c(DIM, "Discovering providers and models..."));
	const providers = await registry.discover();

	if (flags.json) {
		console.log(JSON.stringify(registry.toJSON(), null, 2));
		return;
	}
	printProviderSummary(providers);
	console.log(c(DIM, `\nCached to ~/.kosha/cache  ·  Manifest: ~/.kosha/registry.json`));
}

// ── latest ───────────────────────────────────────────────────────────────

/**
 * Fetch the latest provider/model details by forcing live discovery.
 *
 * Unlike regular list/search commands, this bypasses cache and always
 * performs a fresh discovery pass (plus LiteLLM enrichment).
 *
 * @param registry  The model registry to discover into.
 * @param flags     CLI flags (supports `--provider`, `--json`).
 */
export async function cmdLatest(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	console.log(c(DIM, provider
		? `Fetching latest details for provider "${provider}"...`
		: "Fetching latest details for all providers..."));

	const result = await registry.fetchLatestDetails({
		providers: provider ? [provider] : undefined,
	});

	if (flags.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	printProviderSummary(result.providers);
	console.log(c(DIM, `\nFetched at: ${formatTimestamp(result.discoveredAt)}`));
}

// ── list ─────────────────────────────────────────────────────────────────

/**
 * List all known models in a formatted table.
 * Supports filtering by `--provider`, `--origin`, `--mode`, and `--capability`.
 *
 * @param registry  The model registry to query.
 * @param flags     CLI flags (supports `--provider`, `--origin`, `--mode`, `--capability`, `--json`).
 */
export async function cmdList(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	const originProvider = typeof flags.origin === "string" ? flags.origin : undefined;
	const mode = typeof flags.mode === "string" ? (flags.mode as ModelMode) : undefined;
	const capability = typeof flags.capability === "string" ? flags.capability : undefined;

	await ensureDiscovered(registry);
	const models = registry.models({ provider, originProvider, mode, capability });

	if (flags.json) { console.log(JSON.stringify(models, null, 2)); return; }
	if (models.length === 0) { console.log(c(YELLOW, "No models found matching the given filters.")); return; }

	console.log(renderTable(MODEL_TABLE_COLUMNS, models.map(modelRow)));
	const providerCount = new Set(models.map((m) => m.provider)).size;
	console.log(c(DIM, line("\u2500", 90)));
	console.log(`${c(BOLD, String(models.length))} models from ${c(BOLD, String(providerCount))} providers`);
}

// ── search ───────────────────────────────────────────────────────────────

/**
 * Search for models whose id, name, or aliases contain the query string.
 * Case-insensitive substring matching. Optionally pre-filtered by `--origin`.
 *
 * @param registry  The model registry to search.
 * @param query     The search term (substring).
 * @param flags     CLI flags (supports `--origin`, `--json`).
 */
export async function cmdSearch(registry: ModelRegistry, query: string, flags: Record<string, string | boolean>): Promise<void> {
	if (!query) { console.error(c(RED, "Usage: kosha search <query>")); process.exit(1); }

	await ensureDiscovered(registry);
	const needle = query.toLowerCase();
	const originProvider = typeof flags.origin === "string" ? flags.origin : undefined;

	// Apply optional origin filter first, then substring-match across id, name, and aliases
	const matches = registry.models({ originProvider }).filter(
		(m) =>
			m.id.toLowerCase().includes(needle) ||
			m.name.toLowerCase().includes(needle) ||
			m.aliases.some((a) => a.toLowerCase().includes(needle)),
	);

	if (flags.json) { console.log(JSON.stringify(matches, null, 2)); return; }
	if (matches.length === 0) { console.log(c(YELLOW, `No models matching "${query}"`)); return; }

	console.log(renderTable(MODEL_TABLE_COLUMNS, matches.map(modelRow)));
	console.log(c(DIM, `\n${matches.length} result${matches.length !== 1 ? "s" : ""} for "${query}"`));
}

// ── providers ────────────────────────────────────────────────────────────

/**
 * List all known providers with their authentication status and model counts.
 *
 * @param registry  The model registry to query.
 * @param flags     CLI flags (supports `--json`).
 */
export async function cmdProviders(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	await ensureDiscovered(registry);
	const allProviders = registry.providers_list();

	if (flags.json) { console.log(JSON.stringify(allProviders, null, 2)); return; }
	if (allProviders.length === 0) { console.log(c(YELLOW, "No providers found.")); return; }

	const columns: Column[] = [
		{ header: "Provider", width: 13 },
		{ header: "Status", width: 16 },
		{ header: "Models", width: 7, align: "right" },
		{ header: "Credential Source", width: 30 },
	];

	const rows = allProviders.map((p) => {
		// Three-way status: authenticated, local (no creds needed), or missing
		const status = p.authenticated
			? c(GREEN, "\u2713 authenticated")
			: p.credentialSource === "none"
				? c(GREEN, "\u2713 local")
				: c(RED, "\u2717 no credentials");
		return [c(CYAN, p.id), status, String(p.models.length), formatCredentialSource(p)];
	});

	console.log(renderTable(columns, rows));
}

// ── refresh ──────────────────────────────────────────────────────────────

/**
 * Force a full re-discovery of all providers, bypassing the cache.
 *
 * @param registry  The model registry to refresh.
 * @param flags     CLI flags (supports `--json`).
 */
export async function cmdRefresh(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	console.log(c(DIM, provider ? `Refreshing provider "${provider}"...` : "Refreshing all providers..."));
	await registry.refresh(provider);

	if (flags.json) {
		console.log(JSON.stringify({
			...registry.toJSON(),
			modelCount: registry.models().length,
		}, null, 2));
		return;
	}

	const providers = registry.providers_list();
	printProviderSummary(providers);
	console.log(c(DIM, `\nManifest exported to ~/.kosha/registry.json`));
}

// ── serve ────────────────────────────────────────────────────────────────

/**
 * Start the HTTP API server on the given port.
 * The server module is loaded via dynamic import to avoid pulling in Hono
 * for purely CLI-based usage.
 *
 * @param flags  CLI flags (supports `--port <number>`, default `3000`).
 */
export async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
	const port = typeof flags.port === "string" ? parseInt(flags.port, 10) : 3000;

	if (Number.isNaN(port) || port < 1 || port > 65535) {
		console.error(c(RED, `Invalid port: ${flags.port}`));
		process.exit(1);
	}

	// Dynamic import keeps Hono out of the critical path for non-serve commands
	const { startServer } = await import("./server.js");
	await startServer(port);
}

// ---------------------------------------------------------------------------
//  Re-exports from split modules
// ---------------------------------------------------------------------------

export { cmdModel, cmdResolve, cmdRoutes } from "./cli-cmd-model.js";
export { cmdRoles, cmdCheapest, cmdCapabilities, cmdCapable } from "./cli-cmd-query.js";
export { showHelp, showVersion, showSplash } from "./cli-help.js";
