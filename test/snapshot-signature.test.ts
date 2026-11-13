/**
 * The published snapshot is signed: from the default URL, kosha loads it only
 * when `kosha-latest.json.sig` is a valid Ed25519 signature of the exact bytes.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadSnapshotCatalog,
	resetSnapshotCatalogCache,
	SNAPSHOT_CATALOG_URL,
	SNAPSHOT_PUBLIC_KEY_ENV,
	SNAPSHOT_PUBLIC_KEYS,
	snapshotSignatureValid,
	snapshotTrustedKeys,
} from "../src/discovery/snapshot-catalog.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519");

const body = JSON.stringify({
	providers: [
		{
			id: "openai",
			models: [{ id: "m", provider: "openai", mode: "chat", capabilities: [], contextWindow: 1, maxOutputTokens: 1 }],
		},
	],
});
const sigOf = (text: string, key = privateKey) => sign(null, Buffer.from(text), key).toString("base64");

function serve(files: Record<string, string | null>) {
	const fetched = vi.fn(async (url: string) => {
		const text = files[url];
		return text === null || text === undefined
			? new Response("nope", { status: 404, statusText: "Not Found" })
			: new Response(text, { status: 200 });
	});
	vi.stubGlobal("fetch", fetched);
	return fetched;
}

describe("snapshot signature", () => {
	beforeEach(() => {
		process.env[SNAPSHOT_PUBLIC_KEY_ENV] = PUB;
	});
	afterEach(() => {
		delete process.env[SNAPSHOT_PUBLIC_KEY_ENV];
		delete process.env.KOSHA_SNAPSHOT_URL;
		vi.unstubAllGlobals();
		resetSnapshotCatalogCache();
	});

	it("loads a snapshot signed by a trusted key", async () => {
		serve({ [SNAPSHOT_CATALOG_URL]: body, [`${SNAPSHOT_CATALOG_URL}.sig`]: sigOf(body) });
		const catalog = await loadSnapshotCatalog();
		expect(catalog.providers.get("openai")).toHaveLength(1);
	});

	it("refuses a snapshot changed after signing", async () => {
		serve({ [SNAPSHOT_CATALOG_URL]: body.replace('"m"', '"x"'), [`${SNAPSHOT_CATALOG_URL}.sig`]: sigOf(body) });
		await expect(loadSnapshotCatalog()).rejects.toThrow(/does not verify/);
	});

	it("refuses a snapshot with no signature", async () => {
		serve({ [SNAPSHOT_CATALOG_URL]: body, [`${SNAPSHOT_CATALOG_URL}.sig`]: null });
		await expect(loadSnapshotCatalog()).rejects.toThrow(/signature missing/);
	});

	it("refuses a signature by an untrusted key", async () => {
		serve({ [SNAPSHOT_CATALOG_URL]: body, [`${SNAPSHOT_CATALOG_URL}.sig`]: sigOf(body, other.privateKey) });
		await expect(loadSnapshotCatalog()).rejects.toThrow(/does not verify/);
	});

	it("loads a mirror without a pinned key unsigned, the operator's choice", async () => {
		delete process.env[SNAPSHOT_PUBLIC_KEY_ENV];
		process.env.KOSHA_SNAPSHOT_URL = "https://mirror.example/kosha.json";
		const fetched = serve({ "https://mirror.example/kosha.json": body });
		await loadSnapshotCatalog();
		expect(fetched).toHaveBeenCalledTimes(1);
	});

	it("checks the default URL against the built-in keys", () => {
		delete process.env[SNAPSHOT_PUBLIC_KEY_ENV];
		expect(snapshotTrustedKeys(SNAPSHOT_CATALOG_URL)).toBe(SNAPSHOT_PUBLIC_KEYS);
		expect(snapshotTrustedKeys("https://mirror.example/kosha.json")).toBeNull();
	});

	it("ships a real Ed25519 public key", () => {
		expect(SNAPSHOT_PUBLIC_KEYS.length).toBeGreaterThan(0);
		for (const pem of SNAPSHOT_PUBLIC_KEYS) {
			// A malformed key never verifies, so a placeholder would refuse every snapshot.
			expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
			expect(snapshotSignatureValid("x", Buffer.alloc(64), [pem])).toBe(false);
		}
	});
});
