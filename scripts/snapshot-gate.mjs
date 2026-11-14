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
 *        SNAPSHOT_PREVIOUS_SIG — the previous snapshot's .sig; it must verify.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const [freshPath, heldPath, previousPath] = process.argv.slice(2);
if (!freshPath || !heldPath) {
	console.error("usage: snapshot-gate.mjs <fresh.json> <held.md> [previous.json]");
	process.exit(2);
}

const { gateSnapshot } = await import("../dist/index.js");

const fresh = JSON.parse(await readFile(freshPath, "utf8"));
let previous = null;
if (previousPath && existsSync(previousPath)) {
	// A baseline that exists but doesn't parse or verify stops the run: judged
	// against nothing, the gate would take every price and drop every hold.
	const text = await readFile(previousPath, "utf8");
	const sigPath = process.env.SNAPSHOT_PREVIOUS_SIG;
	if (sigPath) {
		const { SNAPSHOT_PUBLIC_KEYS, snapshotSignatureValid } = await import("../dist/discovery/snapshot-catalog.js");
		const signature = Buffer.from((await readFile(sigPath, "utf8")).trim(), "base64");
		if (!snapshotSignatureValid(text, signature, SNAPSHOT_PUBLIC_KEYS)) {
			console.error("[snapshot-gate] the previous snapshot's signature doesn't verify; refusing to gate against it");
			process.exit(1);
		}
	}
	previous = JSON.parse(text);
}
const accept = (process.env.SNAPSHOT_ACCEPT ?? "")
	.split(",")
	.map((ref) => ref.trim())
	.filter(Boolean);

const { envelope, held, accepted } = gateSnapshot(previous, fresh, accept);
const unmatched = accept.filter((ref) => !accepted.includes(ref));
if (unmatched.length > 0) console.error(`[snapshot-gate] no held price for: ${unmatched.join(", ")}`);
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
// Trailing blank line: the diff that follows in the notes must not join the table.
await writeFile(heldPath, `${lines.join("\n")}\n`, "utf8");
console.log(`[snapshot-gate] ${held.length} price(s) held; released ${accepted.length} of ${accept.length} accept ref(s)`);
