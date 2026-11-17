/**
 * kosha-discovery — The newest models, newest first.
 *
 * A model's date is the release date a catalog gives it. Brand-new models
 * often have none yet on the route you'd use, so the date falls back to the
 * same model on another route (a reseller's catalog often dates it first),
 * then to the day kosha first saw it. Each row says which one it used.
 * @module
 */

import { normalizeModelId } from "./normalize.js";
import { getProviderDescriptor, normalizeProviderId } from "./provider-catalog.js";
import type { ModelCard } from "./types.js";

const DAY_MS = 86_400_000;

export interface NewestOptions {
	/** Only models dated within this many days. Default 30. */
	days?: number;
	/** At most this many rows. Default 25. */
	limit?: number;
	/** Only this serving provider. */
	provider?: string;
	/** Only this mode (chat, embedding, image…). */
	mode?: string;
	/** Include reseller routes as their own rows, not just the maker's. */
	includeResellers?: boolean;
	now?: number;
}

export interface NewestModel {
	model: ModelCard;
	/** `YYYY-MM-DD` (or `YYYY-MM`). */
	date: string;
	/** `release`: this route's catalog date; `route`: another route's; `first-seen`: when kosha first saw it. */
	dateSource: "release" | "route" | "first-seen";
	/** Other providers serving the same model. */
	alsoOn: string[];
}

/** `2026-11` sorts as the 1st of the month. */
function releaseTime(date: string | undefined): number | undefined {
	if (!date) return undefined;
	const t = Date.parse(/^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date);
	return Number.isFinite(t) ? t : undefined;
}

/** The maker serving its own model, not a reseller tagged as origin. */
export function isMakerRoute(model: ModelCard): boolean {
	if (!model.originProvider || getProviderDescriptor(model.provider)?.origin === "proxy") return false;
	return (
		(normalizeProviderId(model.originProvider) ?? model.originProvider) ===
		(normalizeProviderId(model.provider) ?? model.provider)
	);
}

/** One key per model across routes: `Qwen/Qwen4-Max` and `qwen4-max` match. */
function modelKey(model: ModelCard): string {
	const id = model.id.includes("/") ? model.id.slice(model.id.lastIndexOf("/") + 1) : model.id;
	// Bedrock-style ids: `us.anthropic.claude-fable-5-2`, `anthropic.claude-fable-5-2-v1:0`.
	const bare = id
		.replace(/^(global|us|eu|apac|jp|au|ca)\./i, "")
		.replace(/^(anthropic|meta|amazon|mistral|cohere|ai21|deepseek|qwen|openai|google|xai|moonshot|minimax|zai)\./i, "")
		.replace(/-v\d+(:\d+)?$/i, "");
	return normalizeModelId(bare).toLowerCase();
}

function better(a: ModelCard, b: ModelCard): ModelCard {
	const am = isMakerRoute(a);
	if (am !== isMakerRoute(b)) return am ? a : b;
	if (!!a.releaseDate !== !!b.releaseDate) return a.releaseDate ? a : b;
	return a;
}

/** The newest models within the window, newest first, one row per model unless `includeResellers`. */
export function newestModels(models: readonly ModelCard[], options: NewestOptions = {}): NewestModel[] {
	const now = options.now ?? Date.now();
	const cutoff = now - (options.days ?? 30) * DAY_MS;
	const providerFilter = options.provider ? (normalizeProviderId(options.provider) ?? options.provider) : undefined;

	const groups = new Map<string, ModelCard[]>();
	for (const model of models) {
		if (options.mode && model.mode !== options.mode) continue;
		const key = modelKey(model);
		const group = groups.get(key);
		if (group) group.push(model);
		else groups.set(key, [model]);
	}

	const rows: NewestModel[] = [];
	for (const group of groups.values()) {
		const dated = group.map((m) => releaseTime(m.releaseDate)).filter((t): t is number => t !== undefined);
		const routeDate = dated.length > 0 ? Math.min(...dated) : undefined;
		const seen = group.map((m) => m.firstSeenAt).filter((t): t is number => typeof t === "number");
		const firstSeen = seen.length > 0 ? Math.min(...seen) : undefined;
		const candidates = providerFilter ? group.filter((m) => m.provider === providerFilter) : group;
		if (candidates.length === 0) continue;
		const picks = options.includeResellers ? candidates : [candidates.reduce(better)];
		for (const model of picks) {
			const own = releaseTime(model.releaseDate);
			const time = own ?? routeDate ?? firstSeen;
			if (time === undefined || time < cutoff || time > now + DAY_MS) continue;
			const dateSource: NewestModel["dateSource"] =
				own !== undefined ? "release" : routeDate !== undefined ? "route" : "first-seen";
			const date =
				own !== undefined && model.releaseDate ? model.releaseDate : new Date(time).toISOString().slice(0, 10);
			const alsoOn = [...new Set(group.filter((m) => m !== model).map((m) => m.provider))].sort();
			rows.push({ model, date, dateSource, alsoOn });
		}
	}

	rows.sort((a, b) => {
		const d = (releaseTime(b.date) ?? 0) - (releaseTime(a.date) ?? 0);
		if (d !== 0) return d;
		const m = Number(isMakerRoute(b.model)) - Number(isMakerRoute(a.model));
		return m !== 0 ? m : a.model.id.localeCompare(b.model.id);
	});
	return rows.slice(0, options.limit ?? 25);
}
