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
	BOLD, CYAN, DIM, GREEN, MAGENTA, RED, YELLOW,
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

function parseNumberFlag(value: string | boolean | undefined): number | undefined {
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

// ── roles ────────────────────────────────────────────────────────────────

/**
 * Show a provider -> model -> roles matrix.
 *
 * Useful for assistants that need to answer: "which providers/models can do X?"
 */
export async function cmdRoles(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	const originProvider = typeof flags.origin === "string" ? flags.origin : undefined;
	const mode = typeof flags.mode === "string" ? (flags.mode as ModelMode) : undefined;
	const capability = typeof flags.capability === "string" ? flags.capability : undefined;
	const role = typeof flags.role === "string" ? flags.role : undefined;

	await ensureDiscovered(registry);
	const providers = registry.providerRoles({ provider, originProvider, mode, capability, role });

	if (flags.json) {
		console.log(JSON.stringify({
			providers,
			count: providers.length,
			modelCount: providers.reduce((sum, p) => sum + p.models.length, 0),
			missingCredentials: registry.missingCredentialPrompts(providers.map((p) => p.id)),
		}, null, 2));
		return;
	}

	if (providers.length === 0) {
		console.log(c(YELLOW, "No provider/model roles found for the given filters."));
		return;
	}

	const columns: Column[] = [
		{ header: "Provider", width: 12 },
		{ header: "Model", width: 40 },
		{ header: "Mode", width: 10 },
		{ header: "Roles", width: 56 },
	];

	const rows = providers.flatMap((providerInfo) =>
		providerInfo.models.map((model) => [
			c(CYAN, providerInfo.id),
			model.id,
			model.mode,
			model.roles.join(", "),
		]));

	console.log(renderTable(columns, rows));

	const missing = registry.missingCredentialPrompts(providers.map((p) => p.id));
	if (missing.length > 0) {
		console.log(c(DIM, "\nMissing provider credentials:"));
		for (const prompt of missing) {
			console.log(`  ${c(YELLOW, prompt.providerId)}: ${prompt.message}`);
		}
	}
}

// ── cheapest ─────────────────────────────────────────────────────────────

/**
 * Return cheapest model candidates for a requested role/capability.
 */
export async function cmdCheapest(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	const originProvider = typeof flags.origin === "string" ? flags.origin : undefined;
	const mode = typeof flags.mode === "string" ? (flags.mode as ModelMode) : undefined;
	const capability = typeof flags.capability === "string" ? flags.capability : undefined;
	const role = typeof flags.role === "string" ? flags.role : undefined;

	await ensureDiscovered(registry);

	const result = registry.cheapestModels({
		provider,
		originProvider,
		mode,
		capability,
		role,
		limit: parseNumberFlag(flags.limit),
		priceMetric: typeof flags["price-metric"] === "string"
			? flags["price-metric"] as "input" | "output" | "blended"
			: undefined,
		inputWeight: parseNumberFlag(flags["input-weight"]),
		outputWeight: parseNumberFlag(flags["output-weight"]),
		includeUnpriced: flags["include-unpriced"] === true,
	});

	if (flags.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	if (result.matches.length === 0) {
		console.log(c(YELLOW, "No priced models found for the requested filters."));
		if (result.missingCredentials.length > 0) {
			console.log(c(DIM, "\nMissing provider credentials:"));
			for (const prompt of result.missingCredentials) {
				console.log(`  ${c(YELLOW, prompt.providerId)}: ${prompt.message}`);
			}
		}
		return;
	}

	const columns: Column[] = [
		{ header: "Provider", width: 12 },
		{ header: "Model", width: 38 },
		{ header: "Mode", width: 10 },
		{ header: "Metric", width: 8 },
		{ header: "Score", width: 10, align: "right" },
		{ header: "$/M in", width: 8, align: "right" },
		{ header: "$/M out", width: 8, align: "right" },
	];

	const rows = result.matches.map((match) => [
		c(CYAN, match.model.provider),
		match.model.id,
		match.model.mode,
		match.priceMetric,
		match.score === undefined ? "\u2014" : formatPrice(match.score),
		formatPrice(match.model.pricing?.inputPerMillion),
		formatPrice(match.model.pricing?.outputPerMillion),
	]);

	console.log(renderTable(columns, rows));
	console.log(c(DIM, `\n${result.pricedCandidates}/${result.candidates} candidates had usable pricing.`));

	if (result.missingCredentials.length > 0) {
		console.log(c(DIM, "\nMissing provider credentials:"));
		for (const prompt of result.missingCredentials) {
			console.log(`  ${c(YELLOW, prompt.providerId)}: ${prompt.message}`);
		}
	}
}

// ── capabilities ─────────────────────────────────────────────────────────

/**
 * Show an aggregated capability overview across all discovered models.
 * Each row shows a capability, how many models/providers support it,
 * and an example model ID for quick reference.
 *
 * @param registry  The model registry to query.
 * @param flags     CLI flags (supports `--provider`, `--json`).
 */
export async function cmdCapabilities(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	const provider = typeof flags.provider === "string" ? flags.provider : undefined;

	await ensureDiscovered(registry);
	const caps = registry.capabilities({ provider });

	if (flags.json) { console.log(JSON.stringify(caps, null, 2)); return; }
	if (caps.length === 0) { console.log(c(YELLOW, "No capabilities found.")); return; }

	const columns: Column[] = [
		{ header: "Capability", width: 20 },
		{ header: "Models", width: 8, align: "right" },
		{ header: "Providers", width: 10, align: "right" },
		{ header: "Example Model", width: 38 },
	];

	const rows = caps.map((cap) => [
		c(CYAN, cap.capability),
		String(cap.modelCount),
		String(cap.providerCount),
		cap.exampleModelId ?? c(DIM, "—"),
	]);

	const totalModels = registry.models({ provider }).length;
	console.log(renderTable(columns, rows));
	console.log(c(DIM, `\n${caps.length} capabilities across ${totalModels} models`));
}

// ── capable ──────────────────────────────────────────────────────────────

/**
 * Show models that support a given capability/role.
 * Normalizes the query so aliases work: "embeddings", "stt", "tools", "vision".
 *
 * @param registry  The model registry to query.
 * @param query     The capability query (e.g. "vision", "embeddings", "tools").
 * @param flags     CLI flags (supports `--provider`, `--origin`, `--json`, `--limit`).
 */
export async function cmdCapable(registry: ModelRegistry, query: string, flags: Record<string, string | boolean>): Promise<void> {
	if (!query) { console.error(c(RED, "Usage: kosha capable <capability>")); process.exit(1); }

	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	const originProvider = typeof flags.origin === "string" ? flags.origin : undefined;
	const mode = typeof flags.mode === "string" ? (flags.mode as ModelMode) : undefined;
	const limit = parseNumberFlag(flags.limit);

	await ensureDiscovered(registry);

	const normalized = registry.normalizeRoleToken(query);
	const allModels = registry.models({ provider, originProvider, mode });
	let models = allModels.filter((m) => registry.modelSupportsRole(m, normalized));

	if (limit !== undefined && limit > 0) {
		models = models.slice(0, limit);
	}

	if (flags.json) { console.log(JSON.stringify(models, null, 2)); return; }

	if (models.length === 0) {
		console.log(c(YELLOW, `No models found with capability "${query}"${normalized !== query ? ` (normalized: "${normalized}")` : ""}`));
		return;
	}

	const header = normalized !== query
		? `Models with capability ${c(CYAN, normalized)} ${c(DIM, `(from "${query}")`)}`
		: `Models with capability ${c(CYAN, normalized)}`;

	console.log(`\n${c(BOLD, header)}\n`);
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

	// Origin provider line: only shown when distinct from the serving-layer provider
	const originLine = model.originProvider && model.originProvider !== model.provider
		? `\n${c(BOLD, "Origin Provider:")} ${c(CYAN, model.originProvider)}`
		: "";
	// Region and project ID are only shown when present (Bedrock / Vertex models)
	const regionLine = model.region ? `\n${c(BOLD, "Region:")} ${model.region}` : "";
	const projectLine = model.projectId ? `\n${c(BOLD, "Project ID:")} ${model.projectId}` : "";

	console.log(`
${c(BOLD, "Model:")} ${model.id}
${c(BOLD, "Name:")} ${model.name}
${c(BOLD, "Provider:")} ${providerName}${originLine}${regionLine}${projectLine}
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

// ── routes ───────────────────────────────────────────────────────────────

/**
 * Show every provider route through which a model can be accessed.
 *
 * A "route" is a serving-layer entry whose normalized model ID matches the
 * given identifier. Output includes direct/preferred markers, origin provider,
 * model version hint, and serving base URL.
 *
 * Pricing columns show `—` when data is unavailable.
 *
 * @param registry   The model registry to query.
 * @param modelId    Canonical model ID or alias to look up.
 * @param flags      CLI flags (supports `--json`).
 */
export async function cmdRoutes(registry: ModelRegistry, modelId: string, flags: Record<string, string | boolean>): Promise<void> {
	if (!modelId) { console.error(c(RED, "Usage: kosha routes <model-id|alias>")); process.exit(1); }

	await ensureDiscovered(registry);
	const routes = registry.modelRouteInfo(modelId);

	if (flags.json) { console.log(JSON.stringify(routes, null, 2)); return; }

	if (routes.length === 0) {
		console.error(c(RED, `No routes found for model: "${modelId}"`));
		process.exit(1);
	}

	const columns: Column[] = [
		{ header: "Pref", width: 4 },
		{ header: "Provider", width: 14 },
		{ header: "Model ID", width: 42 },
		{ header: "Region", width: 14 },
		{ header: "Origin", width: 12 },
		{ header: "Ver", width: 12 },
		{ header: "Base URL", width: 34 },
		{ header: "$/M in", width: 8, align: "right" },
		{ header: "$/M out", width: 8, align: "right" },
	];

	const rows = routes.map((route) => [
		route.isPreferred ? c(GREEN, "*") : route.isDirect ? c(CYAN, "\u00B7") : " ",
		c(CYAN, route.provider),
		route.model.id,
		route.model.region ?? c(DIM, "—"),
		route.originProvider ?? c(DIM, "—"),
		route.version ?? c(DIM, "—"),
		route.baseUrl ?? c(DIM, "—"),
		formatPrice(route.model.pricing?.inputPerMillion),
		formatPrice(route.model.pricing?.outputPerMillion),
	]);

	console.log(`\n${c(BOLD, routes[0].model.name)} ${c(DIM, `(${routes.length} route${routes.length !== 1 ? "s" : ""})`)}\n`);
	console.log(renderTable(columns, rows));
	const preferred = routes.find((route) => route.isPreferred);
	if (preferred) {
		console.log(c(DIM, `\nPreferred route: ${preferred.provider} (${preferred.baseUrl ?? "base URL unknown"})`));
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
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by origin/creator provider (e.g. anthropic)
    --mode <mode>                 Filter by mode (chat, embedding, image, audio)
    --capability <cap>            Filter by capability (vision, function_calling, etc.)
  ${c(CYAN, "search")} <query>                Search models by name/ID (fuzzy match)
    --origin <name>               Restrict search to a specific origin provider
  ${c(CYAN, "model")} <id|alias>              Show detailed info for one model
  ${c(CYAN, "roles")}                         Show provider -> model -> roles matrix
    --role <role>                 Filter by task role (e.g. embeddings, image, tool_use)
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by model creator provider
    --mode <mode>                 Filter by mode (chat, embedding, image, audio, moderation)
    --capability <cap>            Filter by capability tag
  ${c(CYAN, "capabilities")} ${c(DIM, "(caps)")}             Show all capabilities across the ecosystem
    --provider <name>             Scope to one provider
  ${c(CYAN, "capable")} <capability>            List models with a given capability
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by origin/creator provider
    --mode <mode>                 Filter by mode (chat, embedding, image, audio)
    --limit <n>                   Maximum models to show
  ${c(CYAN, "cheapest")}                      Find cheapest eligible models
    --role <role>                 Task role, e.g. embeddings or image
    --capability <cap>            Capability filter (vision, embedding, function_calling)
    --mode <mode>                 Mode filter
    --limit <n>                   Maximum matches to return (default 5)
    --price-metric <metric>       input | output | blended
    --input-weight <n>            Weight for blended metric input price
    --output-weight <n>           Weight for blended metric output price
    --include-unpriced            Include unpriced models after ranked matches
  ${c(CYAN, "routes")} <id|alias>             Show all provider routes for a model
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
  ${c(DIM, "$")} kosha list --origin anthropic
  ${c(DIM, "$")} kosha list --mode embedding --json
  ${c(DIM, "$")} kosha search gemini
  ${c(DIM, "$")} kosha search claude --origin anthropic
  ${c(DIM, "$")} kosha model sonnet
  ${c(DIM, "$")} kosha roles --role embeddings
  ${c(DIM, "$")} kosha capabilities
  ${c(DIM, "$")} kosha capable vision
  ${c(DIM, "$")} kosha capable embeddings --limit 5
  ${c(DIM, "$")} kosha cheapest --role image --limit 3
  ${c(DIM, "$")} kosha routes claude-opus-4-6
  ${c(DIM, "$")} kosha routes gpt-4o --json
  ${c(DIM, "$")} kosha providers
  ${c(DIM, "$")} kosha resolve haiku
  ${c(DIM, "$")} kosha serve --port 8080
`.trim());
}

/** Print the CLI version string to stdout. */
export function showVersion(): void {
	console.log(`kosha-discovery v${VERSION}`);
}

/**
 * Display a branded splash screen when `kosha` is invoked with no arguments.
 *
 * Shows the Kosha logo, tagline, version, and quick-start commands.
 * Uses MAGENTA branding with a clean, minimal layout.
 */
export function showSplash(): void {
	const brandWord =
		`${c(CYAN, "k")}${c(GREEN, "o")}${c(YELLOW, "s")}${c(MAGENTA, "h")}${c(RED, "a")}`;
	const mascot1 = `${c(CYAN, " /\\_/\\ ")} ${c(DIM, "assistant mascot")}`;
	const mascot2 = `${c(CYAN, "( o.o )")} ${c(DIM, "ready to route")}`;
	const mascot3 = `${c(CYAN, " > ^ < ")} ${c(DIM, "providers + models")}`;

	console.log(`
${c(MAGENTA, "  ╔═══════════════════════════════════════════════════╗")}
${c(MAGENTA, "  ║")}                                                   ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}   ${c(BOLD, "  █▄▀ █▀█ █▀ █ █ ▄▀█")}                         ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}   ${c(BOLD, "  █ █ █▄█ ▄█ █▀█ █▀█")}    ${c(DIM, "कोश — treasury")}        ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}                                                   ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}   ${brandWord} ${c(DIM, "AI Model & Provider Discovery Registry")}  ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}   ${c(DIM, `v${VERSION}`)}                                          ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}   ${mascot1}                                ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}   ${mascot2}                                ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}   ${mascot3}                                ${c(MAGENTA, "║")}
${c(MAGENTA, "  ║")}                                                   ${c(MAGENTA, "║")}
${c(MAGENTA, "  ╚═══════════════════════════════════════════════════╝")}

  ${c(BOLD, "Quick start:")}

    ${c(CYAN, "kosha discover")}       Scan all providers for models
    ${c(CYAN, "kosha list")}           List all discovered models
    ${c(CYAN, "kosha search")} ${c(DIM, "<q>")}     Search by name or ID
    ${c(CYAN, "kosha model")} ${c(DIM, "<id>")}     Detailed info for one model
    ${c(CYAN, "kosha capabilities")}   What capabilities exist?
    ${c(CYAN, "kosha capable")} ${c(DIM, "<cap>")}  Models with a given capability
    ${c(CYAN, "kosha roles")}          Provider -> model -> roles matrix
    ${c(CYAN, "kosha cheapest")}       Cheapest models for a role
    ${c(CYAN, "kosha routes")} ${c(DIM, "<id>")}    All provider routes for a model
    ${c(CYAN, "kosha providers")}      Show provider status
    ${c(CYAN, "kosha serve")}          Start the HTTP API server

  ${c(DIM, "Run")} ${c(CYAN, "kosha --help")} ${c(DIM, "for full usage.")}
`);
}
