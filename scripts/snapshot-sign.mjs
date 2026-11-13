#!/usr/bin/env node
/**
 * Snapshot sign — write a detached Ed25519 signature for the snapshot.
 *
 * kosha refuses a snapshot from the default URL unless `<file>.sig` holds a
 * valid signature by a key in SNAPSHOT_PUBLIC_KEYS (src/discovery/snapshot-catalog.ts).
 * The private key comes from the env, never a file in the repo.
 *
 * Usage: node scripts/snapshot-sign.mjs <snapshot.json> <out.sig>
 * Env:   KOSHA_SNAPSHOT_SIGNING_KEY — PKCS#8 PEM of the Ed25519 private key.
 */

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [snapshotPath, sigPath] = process.argv.slice(2);
if (!snapshotPath || !sigPath) {
	console.error("usage: snapshot-sign.mjs <snapshot.json> <out.sig>");
	process.exit(2);
}
const pem = process.env.KOSHA_SNAPSHOT_SIGNING_KEY;
if (!pem?.trim()) {
	console.error("KOSHA_SNAPSHOT_SIGNING_KEY is not set; an unsigned snapshot would be refused by kosha.");
	process.exit(1);
}

const key = createPrivateKey(pem);
const data = await readFile(snapshotPath);
const signature = sign(null, data, key);
// Check our own work before publishing it.
if (!verify(null, data, createPublicKey(key), signature)) {
	console.error("signature failed to verify against its own key");
	process.exit(1);
}
await writeFile(sigPath, `${signature.toString("base64")}\n`, "utf8");
console.log(`[snapshot-sign] signed ${snapshotPath} -> ${sigPath}`);
