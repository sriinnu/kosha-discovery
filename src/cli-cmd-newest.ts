/**
 * cli-cmd-newest.ts — `kosha newest`: the newest models, newest first.
 * @module cli-cmd-newest
 */

import { ensureDiscovered } from "./cli-commands.js";
import type { Column } from "./cli-format.js";
import { BOLD, CYAN, c, DIM, formatContextWindow, line, renderTable, YELLOW } from "./cli-format.js";
import { formatPrice } from "./cli-pricing-detail.js";
import { newestModels } from "./newest.js";
import type { ModelRegistry } from "./registry.js";

const COLUMNS: Column[] = [
	{ header: "Released", width: 12 },
	{ header: "Model", width: 34 },
	{ header: "Provider", width: 12 },
	{ header: "Context", width: 8 },
	{ header: "$/M in", width: 8, align: "right" },
	{ header: "$/M out", width: 8, align: "right" },
	{ header: "Cache rd", width: 9, align: "right" },
];

function intFlag(value: string | boolean | undefined, fallback: number): number {
	const n = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * `kosha newest [--days 30] [--limit 25] [--provider p] [--mode chat] [--all] [--json]`.
 * One row per model on the maker's own route; `--all` lists every route.
 */
export async function cmdNewest(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	await ensureDiscovered(registry);
	const days = intFlag(flags.days, 30);
	const rows = newestModels(registry.models(), {
		days,
		limit: intFlag(flags.limit, 25),
		provider: typeof flags.provider === "string" ? flags.provider : undefined,
		mode: typeof flags.mode === "string" ? flags.mode : undefined,
		includeResellers: flags.all === true,
	});

	if (flags.json) {
		console.log(
			JSON.stringify(
				rows.map((row) => ({
					date: row.date,
					dateSource: row.dateSource,
					providerId: row.model.provider,
					modelId: row.model.id,
					name: row.model.name,
					mode: row.model.mode,
					contextWindow: row.model.contextWindow || null,
					pricing: row.model.pricing ?? null,
					alsoOn: row.alsoOn,
				})),
				null,
				2,
			),
		);
		return;
	}
	if (rows.length === 0) {
		console.log(c(YELLOW, `No models dated in the last ${days} days.`));
		return;
	}
	const table = rows.map((row) => [
		row.dateSource === "release" ? row.date : `${row.date}${row.dateSource === "route" ? "*" : "~"}`,
		row.model.id,
		c(CYAN, row.model.provider),
		formatContextWindow(row.model.contextWindow),
		formatPrice(row.model.pricing?.inputPerMillion),
		formatPrice(row.model.pricing?.outputPerMillion),
		formatPrice(row.model.pricing?.cacheReadPerMillion),
	]);
	console.log(renderTable(COLUMNS, table));
	console.log(c(DIM, line("─", 97)));
	console.log(
		`${c(BOLD, String(rows.length))} models in the last ${days} days. ${c(DIM, "* dated by another route   ~ first seen by kosha")}`,
	);
}
