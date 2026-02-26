/**
 * cli-commands.ts — Command implementations for the kosha CLI.
 *
 * Each exported `cmd*` function corresponds to a top-level CLI sub-command.
 * Formatting utilities are imported from `./cli-format.js` to keep
 * presentation logic separate from command orchestration.
 *
 * @module cli-commands
 */

import type { ModelMode, ProviderInfo } from "./types.js";
import type { ModelRegistry } from "./registry.js";
import {
	BOLD, CYAN, DIM, GREEN, RED, YELLOW,
	c, formatContextWindow, formatNumber, formatPrice, formatTimestamp,
	line, renderTable,
} from "./cli-format.js";
import type { Column } from "./cli-format.js";

/** CLI version string — kept in sync with `package.json`. */
const VERSION = "0.1.0";

/**
 * Standard column layout reused by both `cmdList` and `cmdSearch`.
 * Extracted to avoid duplicating the same six-column definition.
 */
const MODEL_TABLE_COLUMNS: Column[] = [
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
function formatCredentialSource(provider: ProviderInfo): string {
	if (!provider.credentialSource || provider.credentialSource === "none") {
		return c(DIM, "none (local)");
	}
	return `${provider.credentialSource}`;
}

/**
 * Ensure the registry has at least one provider loaded.
 * If empty (first run or stale cache), triggers a full discovery pass.
 *
 * @param registry  The shared model registry instance.
 */
async function ensureDiscovered(registry: ModelRegistry): Promise<void> {
	if (registry.providers_list().length === 0) {
		console.log(c(DIM, "No cached data. Running discovery..."));
		await registry.discover();
	}
}

/**
 * Build a model-table row from a model card (shared by list/search).
 * @param m  A model card object.
 * @returns  An array of formatted cell strings.
 */
function modelRow(m: { provider: string; id: string; mode: string; contextWindow: number; pricing?: { inputPerMillion: number; outputPerMillion: number } }): string[] {
	return [
		c(CYAN, m.provider), m.id, m.mode,
		formatContextWindow(m.contextWindow),
		formatPrice(m.pricing?.inputPerMillion),
		formatPrice(m.pricing?.outputPerMillion),
	];
}

/** Print a provider summary line (used by discover & refresh). */
function printProviderSummary(providers: ProviderInfo[]): void {
	let totalModels = 0;
	for (const p of providers) {
		totalModels += p.models.length;
		const status = p.authenticated ? c(GREEN, "\u2713") : c(RED, "\u2717");
		console.log(`  ${status} ${c(CYAN, p.name)}: ${p.models.length} models`);
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
}

// ── list ─────────────────────────────────────────────────────────────────

/**
 * List all known models in a formatted table.
 * Supports filtering by `--provider`, `--mode`, and `--capability`.
 *
 * @param registry  The model registry to query.
 * @param flags     CLI flags (supports `--provider`, `--mode`, `--capability`, `--json`).
 */
export async function cmdList(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	const mode = typeof flags.mode === "string" ? (flags.mode as ModelMode) : undefined;
	const capability = typeof flags.capability === "string" ? flags.capability : undefined;

	await ensureDiscovered(registry);
	const models = registry.models({ provider, mode, capability });

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
 * Case-insensitive substring matching.
 *
 * @param registry  The model registry to search.
 * @param query     The search term (substring).
 * @param flags     CLI flags (supports `--json`).
 */
export async function cmdSearch(registry: ModelRegistry, query: string, flags: Record<string, string | boolean>): Promise<void> {
	if (!query) { console.error(c(RED, "Usage: kosha search <query>")); process.exit(1); }

	await ensureDiscovered(registry);
	const needle = query.toLowerCase();

	// Match against id, display name, and every alias
	const matches = registry.models().filter(
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

// ── model (detail view) ─────────────────────────────────────────────────

/**
 * Show detailed information for a single model identified by id or alias.
 *
 * If an exact match is not found, falls back to fuzzy substring search.
 * Single fuzzy match is shown automatically; multiple matches produce a
 * disambiguation list (capped at 5 suggestions).
 *
 * @param registry   The model registry to look up.
 * @param idOrAlias  A model id, display name, or alias.
 * @param flags      CLI flags (supports `--json`).
 */
export async function cmdModel(registry: ModelRegistry, idOrAlias: string, flags: Record<string, string | boolean>): Promise<void> {
	if (!idOrAlias) { console.error(c(RED, "Usage: kosha model <id|alias>")); process.exit(1); }

	await ensureDiscovered(registry);
	const model = registry.model(idOrAlias);

	if (!model) {
		// Fuzzy fallback — substring match across id, name, and aliases so users
		// can type fragments like "sonnet" without knowing the full canonical ID.
		const needle = idOrAlias.toLowerCase();
		const fuzzy = registry.models().filter(
			(m) =>
				m.id.toLowerCase().includes(needle) ||
				m.name.toLowerCase().includes(needle) ||
				m.aliases.some((a) => a.toLowerCase().includes(needle)),
		);

		if (fuzzy.length === 1) return cmdModel(registry, fuzzy[0].id, flags);
		if (fuzzy.length > 1) {
			console.log(c(YELLOW, `No exact match for "${idOrAlias}". Did you mean:`));
			for (const m of fuzzy.slice(0, 5)) console.log(`  ${c(CYAN, m.id)} (${m.provider})`);
			return;
		}
		console.error(c(RED, `Model not found: "${idOrAlias}"`));
		process.exit(1);
	}

	if (flags.json) { console.log(JSON.stringify(model, null, 2)); return; }

	const providerName = registry.provider(model.provider)?.name ?? model.provider;
	const pricingStr = model.pricing
		? `${formatPrice(model.pricing.inputPerMillion)} / ${formatPrice(model.pricing.outputPerMillion)} per million tokens (in/out)`
		: c(DIM, "unknown");
	// Cache pricing is optional — only displayed when the model has it
	const cacheStr = model.pricing?.cacheReadPerMillion !== undefined
		? `\nCache Pricing: ${formatPrice(model.pricing.cacheReadPerMillion)} read / ${formatPrice(model.pricing.cacheWritePerMillion)} write per million tokens`
		: "";

	console.log(`
${c(BOLD, "Model:")} ${model.id}
${c(BOLD, "Name:")} ${model.name}
${c(BOLD, "Provider:")} ${providerName}
${c(BOLD, "Mode:")} ${model.mode}
${c(BOLD, "Aliases:")} ${model.aliases.length > 0 ? model.aliases.join(", ") : c(DIM, "none")}
${c(BOLD, "Context Window:")} ${model.contextWindow > 0 ? formatNumber(model.contextWindow) + " tokens" : c(DIM, "unknown")}
${c(BOLD, "Max Output:")} ${model.maxOutputTokens > 0 ? formatNumber(model.maxOutputTokens) + " tokens" : c(DIM, "unknown")}${model.dimensions ? `\n${c(BOLD, "Dimensions:")} ${formatNumber(model.dimensions)}` : ""}
${c(BOLD, "Capabilities:")} ${model.capabilities.join(", ")}
${c(BOLD, "Pricing:")} ${pricingStr}${cacheStr}
${c(BOLD, "Source:")} ${model.source}
${c(BOLD, "Discovered:")} ${formatTimestamp(model.discoveredAt)}
`.trim());
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

// ── resolve ──────────────────────────────────────────────────────────────

/**
 * Resolve a model alias to its canonical provider ID.
 * Unknown aliases are returned as-is with a yellow warning.
 *
 * @param registry  The model registry containing alias mappings.
 * @param alias     The alias string to resolve.
 * @param flags     CLI flags (supports `--json`).
 */
export async function cmdResolve(registry: ModelRegistry, alias: string, flags: Record<string, string | boolean>): Promise<void> {
	if (!alias) { console.error(c(RED, "Usage: kosha resolve <alias>")); process.exit(1); }

	await ensureDiscovered(registry);
	const resolved = registry.resolve(alias);

	if (flags.json) { console.log(JSON.stringify({ alias, resolved }, null, 2)); return; }

	if (resolved === alias) {
		// resolve() returns input unchanged when no alias mapping exists
		console.log(c(YELLOW, `"${alias}" is not a known alias (returned as-is)`));
	} else {
		console.log(`${c(DIM, alias)} ${c(DIM, "\u2192")} ${c(CYAN, resolved)}`);
	}
}

// ── refresh ──────────────────────────────────────────────────────────────

/**
 * Force a full re-discovery of all providers, bypassing the cache.
 *
 * @param registry  The model registry to refresh.
 * @param flags     CLI flags (supports `--json`).
 */
export async function cmdRefresh(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	console.log(c(DIM, "Refreshing all providers..."));
	await registry.refresh();

	if (flags.json) { console.log(JSON.stringify(registry.toJSON(), null, 2)); return; }

	const providers = registry.providers_list();
	printProviderSummary(providers);
	// Overwrite the last summary line to include "Refreshed:" prefix
	// (printProviderSummary already printed the count, so we add context)
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

// ── help & version ───────────────────────────────────────────────────────

/** Print the full CLI usage / help text to stdout. */
export function showHelp(): void {
	console.log(`
${c(BOLD, "kosha")} ${c(DIM, "\u2014 AI Model & Provider Discovery Registry")}

${c(BOLD, "USAGE")}
  kosha <command> [options]

${c(BOLD, "COMMANDS")}
  ${c(CYAN, "discover")}                      Discover all providers and models
  ${c(CYAN, "list")}                          List all known models
    --provider <name>             Filter by provider
    --mode <mode>                 Filter by mode (chat, embedding, image, audio)
    --capability <cap>            Filter by capability (vision, function_calling, etc.)
  ${c(CYAN, "search")} <query>                Search models by name/ID (fuzzy match)
  ${c(CYAN, "model")} <id|alias>              Show detailed info for one model
  ${c(CYAN, "providers")}                     List all providers and their status
  ${c(CYAN, "resolve")} <alias>               Resolve an alias to canonical model ID
  ${c(CYAN, "refresh")}                       Force re-discover all providers (bypass cache)
  ${c(CYAN, "serve")} [--port 3000]           Start HTTP API server

${c(BOLD, "OPTIONS")}
  --json                          Output as JSON (works with any command)
  --help                          Show this help message
  --version                       Show version

${c(BOLD, "EXAMPLES")}
  ${c(DIM, "$")} kosha discover
  ${c(DIM, "$")} kosha list --provider anthropic
  ${c(DIM, "$")} kosha list --mode embedding --json
  ${c(DIM, "$")} kosha search gemini
  ${c(DIM, "$")} kosha model sonnet
  ${c(DIM, "$")} kosha providers
  ${c(DIM, "$")} kosha resolve haiku
  ${c(DIM, "$")} kosha serve --port 8080
`.trim());
}

/** Print the CLI version string to stdout. */
export function showVersion(): void {
	console.log(`kosha-discovery v${VERSION}`);
}
