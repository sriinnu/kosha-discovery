#!/usr/bin/env node
/**
 * Snapshot diff — what changed in the catalog between two discovery snapshots.
 *
 * Prints Markdown for the snapshot release notes: models that appeared,
 * models that disappeared, list-price changes, and models newly marked
 * deprecated. Sections are capped so the notes stay readable (and inside
 * GitHub's release-body limit) on a week where a reseller relists everything.
 *
 * Usage: node scripts/snapshot-diff.mjs <previous.json> <current.json>
 */

import { readFile } from "node:fs/promises";

const [previousPath, currentPath] = process.argv.slice(2);
if (!previousPath || !currentPath) {
	console.error("usage: snapshot-diff.mjs <previous.json> <current.json>");
	process.exit(2);
}

const MAX_ROWS = 40;

const load = async (path) => JSON.parse(await readFile(path, "utf8"));
const [previous, current] = await Promise.all([load(previousPath), load(currentPath)]);

/** `provider\0id` → model, across every provider in a snapshot. */
function index(snapshot) {
	const models = new Map();
	for (const provider of snapshot.providers ?? []) {
		for (const model of provider.models ?? []) models.set(`${provider.id}\0${model.id}`, model);
	}
	return models;
}

const before = index(previous);
const after = index(current);

const added = [...after].filter(([key]) => !before.has(key)).map(([, model]) => model);
const removed = [...before].filter(([key]) => !after.has(key)).map(([, model]) => model);

// Rates are per-token floats scaled up, so 0.45 arrives as 0.44999999999999996;
// round before comparing or printing, or float noise reads as a price change.
const tidy = (rate) => Number(Number(rate ?? 0).toPrecision(6));
const price = (model) => model.pricing && [tidy(model.pricing.inputPerMillion), tidy(model.pricing.outputPerMillion)];
const repriced = [];
const deprecated = [];
for (const [key, model] of after) {
	const old = before.get(key);
	if (!old) continue;
	const was = price(old);
	const now = price(model);
	if (was && now && (was[0] !== now[0] || was[1] !== now[1])) repriced.push({ model, was, now });
	if (model.status === "deprecated" && old.status !== "deprecated") deprecated.push(model);
}

const usd = (pair) => `$${pair[0]} / $${pair[1]}`;
const ref = (model) => `\`${model.provider}\` · \`${model.id}\``;
const byProvider = (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
// Newest first where the catalog dates the release; undated rows keep provider order.
const byRecency = (a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || byProvider(a, b);

function section(title, rows, render) {
	if (rows.length === 0) return [];
	const lines = [`### ${title} (${rows.length})`, ""];
	for (const row of rows.slice(0, MAX_ROWS)) lines.push(`- ${render(row)}`);
	if (rows.length > MAX_ROWS) lines.push(`- …and ${rows.length - MAX_ROWS} more`);
	lines.push("");
	return lines;
}

const out = [
	`**${current.modelCount} models across ${current.providerCount} providers** ` +
		`(${current.modelCount - previous.modelCount >= 0 ? "+" : ""}${current.modelCount - previous.modelCount} since ${String(previous.fetchedAt).slice(0, 10)}).`,
	"",
	...section("New", added.sort(byRecency), (m) =>
		[ref(m), m.releaseDate && `released ${m.releaseDate}`, price(m) && usd(price(m))].filter(Boolean).join(" — "),
	),
	...section("Repriced", repriced.sort((a, b) => byProvider(a.model, b.model)), (r) => `${ref(r.model)} — ${usd(r.was)} → ${usd(r.now)}`),
	...section("Newly deprecated", deprecated.sort(byProvider), ref),
	...section("Gone", removed.sort(byProvider), ref),
];
if (added.length + removed.length + repriced.length + deprecated.length === 0) out.push("No catalog changes.");

console.log(out.join("\n").trimEnd());
