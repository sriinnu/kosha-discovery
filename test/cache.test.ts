import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KoshaCache } from "../src/cache.js";

describe("KoshaCache", () => {
	let tempDir: string;
	let cache: KoshaCache;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "kosha-cache-test-"));
		cache = new KoshaCache(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("set / get round-trip", () => {
		it("stores and retrieves string data", async () => {
			await cache.set("test-key", "hello world");
			const entry = await cache.get<string>("test-key");
			expect(entry).not.toBeNull();
			expect(entry!.data).toBe("hello world");
			expect(entry!.timestamp).toBeTypeOf("number");
		});

		it("stores and retrieves object data", async () => {
			const data = { name: "test", count: 42, nested: { a: true } };
			await cache.set("obj-key", data);
			const entry = await cache.get<typeof data>("obj-key");
			expect(entry).not.toBeNull();
			expect(entry!.data).toEqual(data);
		});

		it("stores and retrieves array data", async () => {
			const data = [1, 2, 3, "four"];
			await cache.set("arr-key", data);
			const entry = await cache.get<typeof data>("arr-key");
			expect(entry).not.toBeNull();
			expect(entry!.data).toEqual(data);
		});

		it("returns null for missing keys", async () => {
			const entry = await cache.get("non-existent");
			expect(entry).toBeNull();
		});

		it("sets a timestamp close to now", async () => {
			const before = Date.now();
			await cache.set("ts-key", "data");
			const after = Date.now();

			const entry = await cache.get<string>("ts-key");
			expect(entry).not.toBeNull();
			expect(entry!.timestamp).toBeGreaterThanOrEqual(before);
			expect(entry!.timestamp).toBeLessThanOrEqual(after);
		});
	});

	describe("isExpired", () => {
		it("returns false when within TTL", () => {
			const now = Date.now();
			expect(cache.isExpired(now, 60_000)).toBe(false);
		});

		it("returns true when past TTL", () => {
			const oldTimestamp = Date.now() - 120_000;
			expect(cache.isExpired(oldTimestamp, 60_000)).toBe(true);
		});

		it("returns false at exactly the TTL boundary", () => {
			const now = Date.now();
			// timestamp === now, ttl === 0 means (now - now > 0) is false
			expect(cache.isExpired(now, 0)).toBe(false);
		});
	});

	describe("invalidate", () => {
		it("removes a cached entry", async () => {
			await cache.set("to-remove", "some data");

			// Verify it exists
			const before = await cache.get("to-remove");
			expect(before).not.toBeNull();

			// Invalidate
			await cache.invalidate("to-remove");

			// Verify it's gone
			const after = await cache.get("to-remove");
			expect(after).toBeNull();
		});

		it("does not throw for non-existent keys", async () => {
			await expect(cache.invalidate("ghost-key")).resolves.not.toThrow();
		});
	});

	describe("clear", () => {
		it("removes all cached entries", async () => {
			await cache.set("key-a", "data-a");
			await cache.set("key-b", "data-b");
			await cache.set("key-c", "data-c");

			await cache.clear();

			expect(await cache.get("key-a")).toBeNull();
			expect(await cache.get("key-b")).toBeNull();
			expect(await cache.get("key-c")).toBeNull();
		});

		it("does not throw on an empty cache", async () => {
			await expect(cache.clear()).resolves.not.toThrow();
		});
	});

	describe("atomic writes", () => {
		it("leaves no .tmp files after set()", async () => {
			await cache.set("atomic-test", { value: 42 });
			const files = await readdir(tempDir);
			const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
			expect(tmpFiles).toHaveLength(0);

			// Verify the data is readable
			const entry = await cache.get<{ value: number }>("atomic-test");
			expect(entry).not.toBeNull();
			expect(entry!.data.value).toBe(42);
		});
	});

	describe("key sanitization", () => {
		it("handles keys with special characters", async () => {
			await cache.set("provider/openai:models", { count: 5 });
			const entry = await cache.get<{ count: number }>("provider/openai:models");
			expect(entry).not.toBeNull();
			expect(entry!.data.count).toBe(5);
		});

		it("handles keys with spaces", async () => {
			await cache.set("my key with spaces", "value");
			const entry = await cache.get<string>("my key with spaces");
			expect(entry).not.toBeNull();
			expect(entry!.data).toBe("value");
		});
	});
});
