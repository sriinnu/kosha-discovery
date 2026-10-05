#!/usr/bin/env node
/**
 * Alias freshness check.
 *
 * The model catalog refreshes itself; the alias table in `src/aliases.ts` is
 * written by hand, and nothing used to say when the two had drifted apart.
 * This reads a discovery snapshot and reports, for the built-in aliases:
 *
 *   dead    — the target ID appears under no provider in the snapshot.
 *   stale   — a bare alias (`opus`, `grok`, `gemini-flash`) points at a version
 *             that has a newer sibling with the same ID shape in the snapshot.
 *
 * Suffixed aliases (`opus-5`, `grok-4.6`, `gpt5`) pin a generation on purpose
 * and are never reported as stale. Ollama-style `name:tag` targets are local
 * pulls, not catalog entries, and are skipped. A bare alias that is held back
 * deliberately goes in `HELD_BACK` below, with the reason.
 *
 * Usage: node scripts/check-alias-freshness.mjs <snapshot.json> [--strict]
 * Exits 1 with --strict when anything is reported; otherwise always 0, and
 * prints GitHub `::warning::` annotations when run inside Actions.
 */

import { readFile } from "node:fs/promises";
import { DEFAULT_ALIASES } from "../dist/aliases.js";

const [snapshotPath, ...flags] = process.argv.slice(2);
if (!snapshotPath) {
	console.error("usage: check-alias-freshness.mjs <snapshot.json> [--strict]");
	process.exit(2);
}
const strict = flags.includes("--strict");

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));

/** model id → provider ids that list it */
const providersById = new Map();
/** model id → release date, where a catalog publishes one */
const releasedOn = new Map();
for (const provider of snapshot.providers ?? []) {
	for (const model of provider.models ?? []) {
		const list = providersById.get(model.id) ?? [];
		list.push(provider.id);
		providersById.set(model.id, list);
		if (model.releaseDate && !releasedOn.has(model.id)) releasedOn.set(model.id, model.releaseDate);
	}
}

/** Bare aliases that intentionally trail the newest sibling. */
const HELD_BACK = new Map([
	["gemini-embed", "embedding-2 is a different vector space; moving the alias would corrupt existing indexes"],
]);

/** Targets that only ever exist as a local pull, so no catalog lists them. */
const LOCAL_ONLY = new Set(["nomic-embed-text"]);

const VERSION = /\d+(?:[.-]\d{1,2})?(?![\d])/;

/**
 * "5-5" → [5, 5]; "3" → [3]. A dotted version is read as a decimal
 * ("4.20" → [4.2]), which is how vendors that use them order releases:
 * Grok 4.20 predates Grok 4.3.
 */
const parseVersion = (text) => (text.includes(".") ? [Number.parseFloat(text)] : text.split("-").map(Number));

const compareVersions = (a, b) => {
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
};

/**
 * Find a newer sibling of `target`: same ID with only the first version token
 * changed (`claude-opus-5` → `claude-opus-5-5`, `gemini-2.5-flash` →
 * `gemini-3.8-flash`). Returns the newest such ID, or undefined.
 */
function newerSibling(target) {
	const match = VERSION.exec(target);
	if (!match) return undefined;
	const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const shape = new RegExp(
		`^${escape(target.slice(0, match.index))}(\\d+(?:[.-]\\d{1,2})?)${escape(target.slice(match.index + match[0].length))}$`,
	);
	const current = parseVersion(match[0]);
	// Only the first provider that lists the target counts as its home. The
	// snapshot orders direct providers ahead of resellers, and resellers coin
	// their own IDs (`gemini-3.1-pro` for what Google calls a preview).
	const home = providersById.get(target)?.[0];

	let best;
	for (const [id, providers] of providersById) {
		if (id === target || !providers.includes(home)) continue;
		const sibling = shape.exec(id);
		if (!sibling) continue;
		const version = parseVersion(sibling[1]);
		// A release date beats reading order out of a version number.
		const dated = releasedOn.has(id) && releasedOn.has(target);
		if (dated ? releasedOn.get(id) <= releasedOn.get(target) : compareVersions(version, current) <= 0) continue;
		if (!best || compareVersions(version, best.version) > 0) best = { id, version };
	}
	return best?.id;
}

const dead = [];
const stale = [];
for (const [alias, target] of Object.entries(DEFAULT_ALIASES)) {
	if (target.includes(":") || LOCAL_ONLY.has(target)) continue; // local pull
	if (!providersById.has(target)) {
		dead.push({ alias, target });
		continue;
	}
	if (/\d/.test(alias) || HELD_BACK.has(alias)) continue; // pinned generation
	const newer = newerSibling(target);
	if (newer) stale.push({ alias, target, newer });
}

const inActions = process.env.GITHUB_ACTIONS === "true";
const report = (message) => console.log(inActions ? `::warning title=Alias freshness::${message}` : message);

for (const { alias, target } of dead) {
	report(`dead alias: ${alias} -> ${target} (no provider in the snapshot lists it)`);
}
for (const { alias, target, newer } of stale) {
	report(`stale alias: ${alias} -> ${target}, but ${newer} exists`);
}

const total = dead.length + stale.length;
console.log(
	total === 0
		? `alias freshness: ${Object.keys(DEFAULT_ALIASES).length} aliases checked, all current`
		: `alias freshness: ${dead.length} dead, ${stale.length} stale of ${Object.keys(DEFAULT_ALIASES).length} aliases`,
);
process.exit(strict && total > 0 ? 1 : 0);
