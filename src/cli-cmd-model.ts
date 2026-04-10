/**
 * cli-cmd-model.ts — Pricing-heavy model detail commands.
 *
 * Contains `cmdModel`, `cmdResolve`, and `cmdRoutes` — the three commands
 * that display detailed per-model information including multi-tier pricing
 * (cache, reasoning, batch, origin).
 *
 * Extracted from `cli-commands.ts` to keep each module under 450 LOC.
 *
 * @module cli-cmd-model
 */

import type { ModelRegistry } from "./registry.js";
import {
	BOLD, CYAN, DIM, GREEN, RED, YELLOW,
	c, formatNumber, formatPrice, formatTimestamp,
	renderTable,
} from "./cli-format.js";
import type { Column } from "./cli-format.js";
import { ensureDiscovered } from "./cli-commands.js";

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
	// Reasoning pricing is optional — shown when providers expose it.
	const reasoningStr = model.pricing?.reasoningInputPerMillion !== undefined || model.pricing?.reasoningOutputPerMillion !== undefined
		? `\nReasoning Pricing: ${formatPrice(model.pricing?.reasoningInputPerMillion)} in / ${formatPrice(model.pricing?.reasoningOutputPerMillion)} out per million tokens`
		: "";
	// Batch API pricing — shown when providers offer async batch discounts.
	const batchStr = model.pricing?.batchInputPerMillion !== undefined || model.pricing?.batchOutputPerMillion !== undefined
		? `\nBatch Pricing: ${formatPrice(model.pricing?.batchInputPerMillion)} in / ${formatPrice(model.pricing?.batchOutputPerMillion)} out per million tokens`
		: "";
	const originPricingStr = model.originPricing
		? `\nOrigin Pricing: ${formatPrice(model.originPricing.inputPerMillion)} / ${formatPrice(model.originPricing.outputPerMillion)} per million tokens (in/out)` +
			((model.originPricing.reasoningInputPerMillion !== undefined || model.originPricing.reasoningOutputPerMillion !== undefined)
				? `\nOrigin Reasoning Pricing: ${formatPrice(model.originPricing.reasoningInputPerMillion)} in / ${formatPrice(model.originPricing.reasoningOutputPerMillion)} out per million tokens`
				: "") +
			((model.originPricing.batchInputPerMillion !== undefined || model.originPricing.batchOutputPerMillion !== undefined)
				? `\nOrigin Batch Pricing: ${formatPrice(model.originPricing.batchInputPerMillion)} in / ${formatPrice(model.originPricing.batchOutputPerMillion)} out per million tokens`
				: "")
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
${c(BOLD, "Pricing:")} ${pricingStr}${cacheStr}${reasoningStr}${batchStr}${originPricingStr}
${c(BOLD, "Source:")} ${model.source}
${c(BOLD, "Discovered:")} ${formatTimestamp(model.discoveredAt)}
`.trim());
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
	// I look the model up after resolving so callers get pricing (incl. cache
	// read/write rates), context window, and capabilities — not just an ID.
	// Downstream tools that pipe `kosha resolve --json` were missing all of
	// this and had to follow up with `kosha model`. Now one call is enough.
	//
	// Fallback: aliases like `sonnet → claude-sonnet-4-6` may resolve to
	// canonical IDs that no provider serves directly (e.g. when Anthropic
	// API discovery is unauthenticated and OpenRouter exposes the same
	// model as `anthropic/claude-sonnet-4.6`). In that case I lean on
	// modelRoutes(), which normalizes IDs and returns every provider route
	// — picking the first as the representative for pricing display.
	let model = registry.model(resolved);
	if (!model) {
		const routes = registry.modelRoutes(resolved);
		if (routes.length > 0) model = routes[0];
	}

	if (flags.json) {
		console.log(JSON.stringify({ alias, resolved, model: model ?? null }, null, 2));
		return;
	}

	if (resolved === alias && !model) {
		// resolve() returns input unchanged when no alias mapping exists
		console.log(c(YELLOW, `"${alias}" is not a known alias (returned as-is)`));
		return;
	}

	if (resolved !== alias) {
		console.log(`${c(DIM, alias)} ${c(DIM, "\u2192")} ${c(CYAN, resolved)}`);
	} else {
		console.log(c(CYAN, resolved));
	}

	if (model?.pricing) {
		const base = `${formatPrice(model.pricing.inputPerMillion)} / ${formatPrice(model.pricing.outputPerMillion)} per M tokens (in/out)`;
		console.log(`${c(DIM, "Pricing:")} ${base}`);
		if (model.pricing.cacheReadPerMillion !== undefined || model.pricing.cacheWritePerMillion !== undefined) {
			const read = model.pricing.cacheReadPerMillion !== undefined
				? formatPrice(model.pricing.cacheReadPerMillion)
				: c(DIM, "\u2014");
			const write = model.pricing.cacheWritePerMillion !== undefined
				? formatPrice(model.pricing.cacheWritePerMillion)
				: c(DIM, "\u2014");
			console.log(`${c(DIM, "Cache:  ")} ${read} read / ${write} write per M tokens`);
		}
		if (model.pricing.batchInputPerMillion !== undefined || model.pricing.batchOutputPerMillion !== undefined) {
			const bIn = model.pricing.batchInputPerMillion !== undefined
				? formatPrice(model.pricing.batchInputPerMillion)
				: c(DIM, "\u2014");
			const bOut = model.pricing.batchOutputPerMillion !== undefined
				? formatPrice(model.pricing.batchOutputPerMillion)
				: c(DIM, "\u2014");
			console.log(`${c(DIM, "Batch:  ")} ${bIn} in / ${bOut} out per M tokens`);
		}
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
		route.model.region ?? c(DIM, "\u2014"),
		route.originProvider ?? c(DIM, "\u2014"),
		route.version ?? c(DIM, "\u2014"),
		route.baseUrl ?? c(DIM, "\u2014"),
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
