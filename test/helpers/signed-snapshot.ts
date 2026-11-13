/**
 * A throwaway Ed25519 key for tests that load the published snapshot, which
 * kosha now refuses unless `<url>.sig` verifies. `trustTestKey()` pins the
 * key through KOSHA_SNAPSHOT_PUBKEY; `snapshotResponse()` answers both the
 * snapshot URL and its `.sig` for the same body.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { SNAPSHOT_PUBLIC_KEY_ENV } from "../../src/discovery/snapshot-catalog.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

export function trustTestKey(): void {
	process.env[SNAPSHOT_PUBLIC_KEY_ENV] = publicKey.export({ type: "spki", format: "pem" }).toString();
}

export function forgetTestKey(): void {
	delete process.env[SNAPSHOT_PUBLIC_KEY_ENV];
}

/** A Response for `url`: the signature when it asks for `.sig`, else the body. */
export function snapshotResponse(url: string, body: string, init: ResponseInit = { status: 200 }): Response {
	if (url.endsWith(".sig")) return new Response(sign(null, Buffer.from(body), privateKey).toString("base64"));
	return new Response(body, init);
}
