#!/usr/bin/env node
/**
 * Snapshot gate — hold suspect price moves in the weekly snapshot.
 *
 * Runs the fresh snapshot through the same price quarantine as a local
 * manifest, judged against the snapshot published before it (see
 * src/snapshot-gate.ts). Rewrites the fresh file in place and writes a
 * Markdown list of held prices for the release notes.
 *
 * Usage: node scripts/snapshot-gate.mjs <fresh.json> <held.md> [previous.json]
 * Env:   SNAPSHOT_ACCEPT — comma-separated provider/model refs to release.
 */

import { readFile, writeFile } from "node:fs/promises";

const [freshPath, heldPath, previousPath] = process.argv.slice(2);
if (!freshPath || !heldPath) {
	console.error("usage: snapshot-gate.mjs <fresh.json> <held.md> [previous.json]");
	process.exit(2);
}

const { gateSnapshot } = await import("../dist/index.js");

const fresh = JSON.parse(await readFile(freshPath, "utf8"));
let previous = null;
if (previousPath) {
	try {
		previous = JSON.parse(await readFile(previousPath, "utf8"));
	} catch {
		/* first snapshot: nothing to judge against */
	}
}
const accept = (process.env.SNAPSHOT_ACCEPT ?? "")
	.split(",")
	.map((ref) => ref.trim())
	.filter(Boolean);

const { envelope, held } = gateSnapshot(previous, fresh, accept);
await writeFile(freshPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

const rate = (p) =>
	p ? `$${Number(p.inputPerMillion ?? 0).toPrecision(4)} / $${Number(p.outputPerMillion ?? 0).toPrecision(4)}` : "none";
const lines = [];
if (held.length > 0) {
	lines.push(`### Prices held (${held.length})`, "");
	lines.push("Published at the previous price until the move has been seen for its hold window.", "");
	lines.push("| Model | Published (in / out per 1M) | Reported | Seen since |", "|---|---|---|---|");
	for (const h of held.slice(0, 40)) {
		lines.push(
			`| \`${h.providerId}/${h.modelId}\` | ${rate(h.published)} | ${rate(h.reported) === rate(h.published) ? "same; a cache or other rate moved" : rate(h.reported)} | ${new Date(h.since).toISOString().slice(0, 10)} |`,
		);
	}
	if (held.length > 40) lines.push("", `_…and ${held.length - 40} more._`);
	lines.push("");
}
await writeFile(heldPath, lines.join("\n"), "utf8");
console.log(`[snapshot-gate] ${held.length} price(s) held; accepted ${accept.length} ref(s)`);
