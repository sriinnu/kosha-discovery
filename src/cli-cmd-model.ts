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

import { ensureDiscovered } from "./cli-commands.js";
import type { Column } from "./cli-format.js";
import {
	BOLD,
	CYAN,
	c,
	DIM,
	formatBatchDiscount,
	formatNumber,
	formatPrice,
	formatTimestamp,
	GREEN,
	RED,
	renderTable,
	YELLOW,
} from "./cli-format.js";
import { pricingDetail } from "./cli-pricing-detail.js";
import { isPlanBilled } from "./discovery/free-tier.js";
import { isRetired } from "./lifecycle.js";
import { resolvePricing } from "./pricing-resolve.js";
import { getProviderCacheBehavior } from "./provider-catalog.js";
import type { ModelRegistry } from "./registry.js";
import type { ModelPricing } from "./types.js";

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
export async function cmdModel(
	registry: ModelRegistry,
	idOrAlias: string,
	flags: Record<string, string | boolean>,
): Promise<void> {
	if (!idOrAlias) {
		console.error(c(RED, "Usage: kosha model <id|alias>"));
		process.exit(1);
	}

	await ensureDiscovered(registry);
	const model = registry.model(idOrAlias);

	if (!model) {
		// Fuzzy fallback — substring match across id, name, and aliases so users
		// can type fragments like "sonnet" without knowing the full canonical ID.
		const needle = idOrAlias.toLowerCase();
		const fuzzy = registry
			.models()
			.filter(
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

	if (flags.json) {
		console.log(JSON.stringify(model, null, 2));
		return;
	}

	const providerName = registry.provider(model.provider)?.name ?? model.provider;
	const resolved = model.pricing ? resolvePricing(model.pricing) : undefined;
	const pricingStr = resolved
		? `${formatPrice(resolved.inputPerMillion)} / ${formatPrice(resolved.outputPerMillion)} per million tokens (in/out)${resolved.band ? ` [prompt ${resolved.band.inclusive ? ">=" : ">"} ${resolved.band.aboveInputTokens.toLocaleString()} tokens]` : ""}`
		: isPlanBilled(model)
			? c(DIM, "included in the subscription plan (no per-token price)")
			: c(DIM, "unknown");
	// Cache pricing is optional — only displayed when the model has it
	// Cache writes by lifetime, long-prompt bands, dated changes and the cited page.
	const cacheStr = pricingDetail(model.pricing, (text) => text);
	const unitPricingStr = formatUnitPricingLines(model.pricing);
	// Reasoning pricing is optional — shown when providers expose it.
	const reasoningStr =
		resolved?.reasoningInputPerMillion !== undefined || resolved?.reasoningOutputPerMillion !== undefined
			? `\nReasoning Pricing: ${formatPrice(resolved?.reasoningInputPerMillion)} in / ${formatPrice(resolved?.reasoningOutputPerMillion)} out per million tokens`
			: "";
	// Batch API pricing — shown when providers offer async batch discounts.
	const batchDiscount = formatBatchDiscount(resolved);
	const batchStr =
		resolved?.batchInputPerMillion !== undefined || resolved?.batchOutputPerMillion !== undefined
			? `\nBatch Pricing: ${formatPrice(resolved?.batchInputPerMillion)} in / ${formatPrice(resolved?.batchOutputPerMillion)} out per million tokens${batchDiscount ? ` ${batchDiscount}` : ""}`
			: "";
	const resolvedOrigin = model.originPricing ? resolvePricing(model.originPricing) : undefined;
	const serviceTiersStr =
		resolved?.serviceTiers && Object.keys(resolved.serviceTiers).length > 0
			? `\nService Tiers: ${Object.entries(resolved.serviceTiers)
					.map(
						([tier, r]) =>
							`${tier} (${formatPrice(r.inputPerMillion)} / ${formatPrice(r.outputPerMillion)} in/out${r.cacheReadPerMillion !== undefined ? `, ${formatPrice(r.cacheReadPerMillion)} read` : ""})`,
					)
					.join("; ")}`
			: "";
	const originPricingStr = resolvedOrigin
		? `\nOrigin Pricing: ${formatPrice(resolvedOrigin.inputPerMillion)} / ${formatPrice(resolvedOrigin.outputPerMillion)} per million tokens (in/out)` +
			(resolvedOrigin.reasoningInputPerMillion !== undefined ||
			resolvedOrigin.reasoningOutputPerMillion !== undefined
				? `\nOrigin Reasoning Pricing: ${formatPrice(resolvedOrigin.reasoningInputPerMillion)} in / ${formatPrice(resolvedOrigin.reasoningOutputPerMillion)} out per million tokens`
				: "") +
			(resolvedOrigin.batchInputPerMillion !== undefined || resolvedOrigin.batchOutputPerMillion !== undefined
				? `\nOrigin Batch Pricing: ${formatPrice(resolvedOrigin.batchInputPerMillion)} in / ${formatPrice(resolvedOrigin.batchOutputPerMillion)} out per million tokens`
				: "")
		: "";
	const evidenceSources = model.priceEvidence?.map((entry) => entry.source).filter(Boolean) ?? [];
	const provenanceLine =
		model.pricingSource || evidenceSources.length > 0
			? `\n${c(BOLD, "Price Provenance:")} ${[model.pricingSource, evidenceSources.length > 0 ? `witnesses: ${evidenceSources.join(", ")}` : undefined].filter(Boolean).join(" | ")}`
			: "";
	const statusLine =
		model.status && model.status !== "active"
			? `\n${c(BOLD, "Status:")} ${model.status}${model.deprecationDate ? ` (sunset ${model.deprecationDate})` : ""}${model.replacedBy ? ` -> ${model.replacedBy}` : ""}`
			: model.deprecationDate
				? `\n${c(BOLD, "Sunset:")} ${model.deprecationDate}${model.replacedBy ? ` -> ${model.replacedBy}` : ""}`
				: "";
	const cacheBehavior = getProviderCacheBehavior(model.provider);
	const cacheBehaviorLine = cacheBehavior ? `\n${c(BOLD, "Cache Behavior:")} ${cacheBehavior.mode}` : "";
	const priceHoldFlags = (model.rawCapabilities ?? []).filter(
		(tag) => tag === "pricing_quarantined" || tag === "pricing_sources_disagree" || tag === "pricing_single_source",
	);
	const priceWarningLine =
		priceHoldFlags.length > 0 ? `\n${c(YELLOW, "Price Warning:")} ${priceHoldFlags.join(", ")}` : "";
	const dialectParts = [
		model.toolDialect ? `tool dialect: ${model.toolDialect}` : undefined,
		model.supportsParallelToolCalls !== undefined ? `parallel tools: ${model.supportsParallelToolCalls}` : undefined,
		model.structuredOutputModes?.length ? `structured output: ${model.structuredOutputModes.join(", ")}` : undefined,
	].filter(Boolean);
	const dialectLine = dialectParts.length > 0 ? `\n${c(BOLD, "Tooling:")} ${dialectParts.join(" · ")}` : "";

	// Origin provider line: only shown when distinct from the serving-layer provider
	const originLine =
		model.originProvider && model.originProvider !== model.provider
			? `\n${c(BOLD, "Origin Provider:")} ${c(CYAN, model.originProvider)}`
			: "";
	// Region and project ID are only shown when present (Bedrock / Vertex models)
	const regionLine = model.region ? `\n${c(BOLD, "Region:")} ${model.region}` : "";
	const projectLine = model.projectId ? `\n${c(BOLD, "Project ID:")} ${model.projectId}` : "";

	console.log(
		`
${c(BOLD, "Model:")} ${model.id}
${c(BOLD, "Name:")} ${model.name}
${c(BOLD, "Provider:")} ${providerName}${originLine}${regionLine}${projectLine}
${c(BOLD, "Mode:")} ${model.mode}${statusLine}
${c(BOLD, "Aliases:")} ${model.aliases.length > 0 ? model.aliases.join(", ") : c(DIM, "none")}
${c(BOLD, "Context Window:")} ${model.contextWindow > 0 ? `${formatNumber(model.contextWindow)} tokens` : c(DIM, model.source === "api" ? "unknown (the provider doesn't say, and no catalog lists it yet)" : "unknown")}
${c(BOLD, "Max Output:")} ${model.maxOutputTokens > 0 ? formatNumber(model.maxOutputTokens) + " tokens" : c(DIM, "unknown")}${model.dimensions ? `\n${c(BOLD, "Dimensions:")} ${formatNumber(model.dimensions)}` : ""}
${c(BOLD, "Capabilities:")} ${model.capabilities.join(", ")}${dialectLine}
${c(BOLD, "Pricing:")} ${pricingStr}${cacheStr}${unitPricingStr}${reasoningStr}${batchStr}${serviceTiersStr}${originPricingStr}${provenanceLine}${priceWarningLine}${cacheBehaviorLine}
${c(BOLD, "Source:")} ${model.source}
${c(BOLD, "Released:")} ${model.releaseDate ?? c(DIM, "unknown (no catalog dates it yet)")}
${c(BOLD, "Discovered:")} ${formatTimestamp(model.discoveredAt)}
`.trim(),
	);
}

function formatUnitPricingLines(pricing: ModelPricing | undefined): string {
	if (!pricing) return "";
	const parts: string[] = [];
	if (pricing.imageOutputPerImage !== undefined) parts.push(`${formatPrice(pricing.imageOutputPerImage)}/image out`);
	if (pricing.imageInputPerImage !== undefined) parts.push(`${formatPrice(pricing.imageInputPerImage)}/image in`);
	if (pricing.audioInputPerMillion !== undefined || pricing.audioOutputPerMillion !== undefined) {
		parts.push(
			`${formatPrice(pricing.audioInputPerMillion)} / ${formatPrice(pricing.audioOutputPerMillion)} per M audio tokens (in/out)`,
		);
	}
	if (pricing.audioInputPerSecond !== undefined) parts.push(`${formatPrice(pricing.audioInputPerSecond)}/s audio in`);
	if (pricing.audioOutputPerSecond !== undefined) parts.push(`${formatPrice(pricing.audioOutputPerSecond)}/s audio out`);
	if (pricing.videoInputPerMillion !== undefined) parts.push(`${formatPrice(pricing.videoInputPerMillion)} per M video tokens in`);
	if (pricing.videoInputPerSecond !== undefined) parts.push(`${formatPrice(pricing.videoInputPerSecond)}/s video in`);
	if (pricing.videoOutputPerSecond !== undefined) parts.push(`${formatPrice(pricing.videoOutputPerSecond)}/s video out`);
	if (pricing.inputPerMillionCharacters !== undefined || pricing.outputPerMillionCharacters !== undefined) {
		parts.push(
			`${formatPrice(pricing.inputPerMillionCharacters)} / ${formatPrice(pricing.outputPerMillionCharacters)} per M chars (in/out)`,
		);
	}
	if (pricing.requestPerThousand !== undefined) parts.push(`${formatPrice(pricing.requestPerThousand)}/1K requests`);
	if (pricing.webSearchPerThousandRequests !== undefined) {
		parts.push(`${formatPrice(pricing.webSearchPerThousandRequests)}/1K web searches`);
	}
	if (pricing.mapsSearchPerThousandRequests !== undefined) {
		parts.push(`${formatPrice(pricing.mapsSearchPerThousandRequests)}/1K maps searches`);
	}
	return parts.length > 0 ? `\nUnit Pricing: ${parts.join(", ")}` : "";
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
export async function cmdResolve(
	registry: ModelRegistry,
	alias: string,
	flags: Record<string, string | boolean>,
): Promise<void> {
	if (!alias) {
		console.error(c(RED, "Usage: kosha resolve <alias>"));
		process.exit(1);
	}

	await ensureDiscovered(registry);
	const resolved = registry.resolve(alias);
	// I look the model up after resolving so callers get pricing (incl. cache
	// read/write rates), context window, and capabilities — not just an ID.
	// Downstream tools that pipe `kosha resolve --json` were missing all of
	// this and had to follow up with `kosha model`. Now one call is enough.
	//
	// Fallback: aliases like `sonnet → claude-sonnet-5` may resolve to
	// canonical IDs that no provider serves directly (e.g. when Anthropic
	// API discovery is unauthenticated and OpenRouter exposes the same
	// model as `anthropic/claude-sonnet-5`). In that case I lean on
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
		const resolvedPricing = resolvePricing(model.pricing);
		const base = `${formatPrice(resolvedPricing.inputPerMillion)} / ${formatPrice(resolvedPricing.outputPerMillion)} per M tokens (in/out)`;
		console.log(`${c(DIM, "Pricing:")} ${base}`);
		if (resolvedPricing.cacheReadPerMillion !== undefined || resolvedPricing.cacheWritePerMillion !== undefined) {
			const read =
				resolvedPricing.cacheReadPerMillion !== undefined
					? formatPrice(resolvedPricing.cacheReadPerMillion)
					: c(DIM, "\u2014");
			const write =
				resolvedPricing.cacheWritePerMillion !== undefined
					? formatPrice(resolvedPricing.cacheWritePerMillion)
					: c(DIM, "\u2014");
			console.log(`${c(DIM, "Cache:  ")} ${read} read / ${write} write per M tokens`);
		}
		if (resolvedPricing.batchInputPerMillion !== undefined || resolvedPricing.batchOutputPerMillion !== undefined) {
			const bIn =
				resolvedPricing.batchInputPerMillion !== undefined
					? formatPrice(resolvedPricing.batchInputPerMillion)
					: c(DIM, "\u2014");
			const bOut =
				resolvedPricing.batchOutputPerMillion !== undefined
					? formatPrice(resolvedPricing.batchOutputPerMillion)
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
export async function cmdRoutes(
	registry: ModelRegistry,
	modelId: string,
	flags: Record<string, string | boolean>,
): Promise<void> {
	if (!modelId) {
		console.error(c(RED, "Usage: kosha routes <model-id|alias>"));
		process.exit(1);
	}

	await ensureDiscovered(registry);
	const routes = registry.modelRouteInfo(modelId);

	if (flags.json) {
		console.log(JSON.stringify(routes, null, 2));
		return;
	}

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
		isRetired(route.model) ? c(RED, "x") : route.isPreferred ? c(GREEN, "*") : route.isDirect ? c(CYAN, "\u00B7") : " ",
		c(CYAN, route.provider),
		route.model.id,
		route.model.region ?? c(DIM, "\u2014"),
		route.originProvider ?? c(DIM, "\u2014"),
		route.version ?? c(DIM, "\u2014"),
		route.baseUrl ?? c(DIM, "\u2014"),
		formatPrice(route.model.pricing?.inputPerMillion),
		formatPrice(route.model.pricing?.outputPerMillion),
	]);

	console.log(
		`\n${c(BOLD, routes[0].model.name)} ${c(DIM, `(${routes.length} route${routes.length !== 1 ? "s" : ""})`)}\n`,
	);
	console.log(renderTable(columns, rows));
	const preferred = routes.find((route) => route.isPreferred);
	if (preferred) {
		console.log(c(DIM, `\nPreferred route: ${preferred.provider} (${preferred.baseUrl ?? "base URL unknown"})`));
	}
	const retired = routes.filter((route) => isRetired(route.model)).length;
	if (retired > 0) {
		console.log(
			c(
				DIM,
				`${retired === routes.length ? "Every route" : `${retired} route(s)`} marked x is past its sunset and no longer served.`,
			),
		);
	}
}
