/**
 * cli-cmd-query.ts — Role, capability, and pricing query commands.
 *
 * Contains `cmdRoles`, `cmdCheapest`, `cmdCapabilities`, and `cmdCapable` —
 * commands that query and filter models by roles, capabilities, and pricing.
 *
 * Extracted from `cli-commands.ts` to keep each module under 450 LOC.
 *
 * @module cli-cmd-query
 */

import type { ModelMode } from "./types.js";
import type { ModelRegistry } from "./registry.js";
import {
	BOLD, CYAN, DIM, RED, YELLOW,
	c, formatPrice, formatPricingTier, line, renderTable,
} from "./cli-format.js";
import type { Column } from "./cli-format.js";

async function ensureDiscovered(registry: ModelRegistry): Promise<void> {
	const candidate = registry as unknown as {
		discover?: () => Promise<unknown>;
		ensureDiscovered?: () => Promise<unknown>;
		isDiscovered?: () => boolean;
	};

	if (typeof candidate.ensureDiscovered === "function") {
		await candidate.ensureDiscovered();
		return;
	}

	if (typeof candidate.isDiscovered === "function" && candidate.isDiscovered()) {
		return;
	}

	if (typeof candidate.discover === "function") {
		await candidate.discover();
	}
}

function parseNumberFlag(
	flags: Record<string, string | boolean>,
	name: string,
	fallback?: number,
): number | undefined {
	const raw = flags[name];
	if (typeof raw !== "string" || raw.trim() === "") {
		return fallback;
	}

	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

const MODEL_TABLE_COLUMNS: Column[] = [
	{ header: "Provider", width: 12 },
	{ header: "Model", width: 40 },
	{ header: "Mode", width: 10 },
	{ header: "Input", width: 12 },
	{ header: "Output", width: 12 },
];

const PRICING_TABLE_COLUMNS: Column[] = [
	{ header: "Provider", width: 12 },
	{ header: "Model", width: 34 },
	{ header: "Mode", width: 10 },
	{ header: "Tier", width: 6 },
	{ header: "$/M in", width: 8, align: "right" },
	{ header: "$/M out", width: 8, align: "right" },
	{ header: "Cache R", width: 8, align: "right" },
	{ header: "Cache W", width: 8, align: "right" },
	{ header: "Batch in", width: 8, align: "right" },
	{ header: "Batch out", width: 9, align: "right" },
];

function modelRow(model: {
	providerId?: string;
	provider?: string;
	id?: string;
	mode?: string;
	inputPrice?: number | null;
	outputPrice?: number | null;
}): string[] {
	return [
		c(CYAN, model.providerId ?? model.provider ?? ""),
		model.id ?? "",
		model.mode ?? "",
		formatPrice(model.inputPrice ?? undefined),
		formatPrice(model.outputPrice ?? undefined),
	];
}

function pricingRow(model: {
	provider?: string;
	id?: string;
	mode?: string;
	pricing?: {
		inputPerMillion: number; outputPerMillion: number;
		cacheReadPerMillion?: number; cacheWritePerMillion?: number;
		batchInputPerMillion?: number; batchOutputPerMillion?: number;
	};
}): string[] {
	return [
		c(CYAN, model.provider ?? ""),
		model.id ?? "",
		model.mode ?? "",
		formatPricingTier(model.pricing),
		formatPrice(model.pricing?.inputPerMillion),
		formatPrice(model.pricing?.outputPerMillion),
		formatPrice(model.pricing?.cacheReadPerMillion),
		formatPrice(model.pricing?.cacheWritePerMillion),
		formatPrice(model.pricing?.batchInputPerMillion),
		formatPrice(model.pricing?.batchOutputPerMillion),
	];
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
	const showPricing = flags.pricing === true;

	await ensureDiscovered(registry);

	const result = registry.cheapestModels({
		provider,
		originProvider,
		mode,
		capability,
		role,
		limit: parseNumberFlag(flags, "limit"),
		priceMetric: typeof flags["price-metric"] === "string"
			? flags["price-metric"] as "input" | "output" | "blended"
			: undefined,
		inputWeight: parseNumberFlag(flags, "input-weight"),
		outputWeight: parseNumberFlag(flags, "output-weight"),
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

	if (showPricing) {
		const columns: Column[] = [
			{ header: "Provider", width: 12 },
			{ header: "Model", width: 30 },
			{ header: "Metric", width: 8 },
			{ header: "Tier", width: 6 },
			{ header: "Score", width: 8, align: "right" },
			{ header: "$/M in", width: 8, align: "right" },
			{ header: "$/M out", width: 8, align: "right" },
			{ header: "Cache R", width: 8, align: "right" },
			{ header: "Cache W", width: 8, align: "right" },
			{ header: "Batch in", width: 8, align: "right" },
			{ header: "Batch out", width: 9, align: "right" },
		];
		const rows = result.matches.map((match) => [
			c(CYAN, match.model.provider),
			match.model.id,
			match.priceMetric,
			formatPricingTier(match.model.pricing),
			match.score === undefined ? "\u2014" : formatPrice(match.score),
			formatPrice(match.model.pricing?.inputPerMillion),
			formatPrice(match.model.pricing?.outputPerMillion),
			formatPrice(match.model.pricing?.cacheReadPerMillion),
			formatPrice(match.model.pricing?.cacheWritePerMillion),
			formatPrice(match.model.pricing?.batchInputPerMillion),
			formatPrice(match.model.pricing?.batchOutputPerMillion),
		]);
		console.log(renderTable(columns, rows));
	} else {
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
	}

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
		cap.exampleModelId ?? c(DIM, "\u2014"),
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
 * @param flags     CLI flags (supports `--provider`, `--origin`, `--pricing`, `--json`, `--limit`).
 */
export async function cmdCapable(registry: ModelRegistry, query: string, flags: Record<string, string | boolean>): Promise<void> {
	if (!query) { console.error(c(RED, "Usage: kosha capable <capability>")); process.exit(1); }

	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	const originProvider = typeof flags.origin === "string" ? flags.origin : undefined;
	const mode = typeof flags.mode === "string" ? (flags.mode as ModelMode) : undefined;
	const limit = parseNumberFlag(flags, "limit");
	const showPricing = flags.pricing === true;

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

	const capableColumns = showPricing ? PRICING_TABLE_COLUMNS : MODEL_TABLE_COLUMNS;
	const capableRowFn = showPricing ? pricingRow : modelRow;
	console.log(renderTable(capableColumns, models.map(capableRowFn)));

	const providerCount = new Set(models.map((m) => m.provider)).size;
	console.log(c(DIM, line("\u2500", showPricing ? 110 : 90)));
	console.log(`${c(BOLD, String(models.length))} models from ${c(BOLD, String(providerCount))} providers`);
}
