/**
 * kosha-discovery — File-based JSON cache with TTL.
 *
 * Stores discovered provider data as individual JSON files on disk
 * to avoid re-fetching from provider APIs on every startup.
 * Each cache key maps to a `{key}.json` file inside the cache directory.
 * @module
 */

import { mkdir, readFile, readdir, rm, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

/**
 * Simple file-based JSON cache with TTL support.
 * Stores discovered provider data to avoid re-fetching on every startup.
 *
 * Each cache key maps to a `{key}.json` file inside the cache directory.
 */
export class KoshaCache {
	private readonly cacheDir: string;

	constructor(cacheDir?: string) {
		this.cacheDir = cacheDir ?? join(homedir(), ".kosha", "cache");
	}

	/**
	 * Retrieve cached data by key.
	 * Returns null if the entry is missing or the file cannot be read.
	 */
	async get<T>(key: string): Promise<CacheEntry<T> | null> {
		try {
			const filePath = this.keyToPath(key);
			const raw = await readFile(filePath, "utf-8");
			const entry = JSON.parse(raw) as CacheEntry<T>;
			return entry;
		} catch {
			return null;
		}
	}

	/**
	 * Write data to the cache under the given key.
	 * Creates the cache directory if it does not exist.
	 */
	async set<T>(key: string, data: T): Promise<void> {
		await this.ensureDir();
		const entry: CacheEntry<T> = {
			data,
			timestamp: Date.now(),
		};
		const filePath = this.keyToPath(key);
		await writeFile(filePath, JSON.stringify(entry, null, "\t"), "utf-8");
	}

	/**
	 * Remove a single cached entry by key.
	 */
	async invalidate(key: string): Promise<void> {
		try {
			const filePath = this.keyToPath(key);
			await unlink(filePath);
		} catch {
			// Ignore if file doesn't exist
		}
	}

	/**
	 * Remove all cache files from the cache directory.
	 */
	async clear(): Promise<void> {
		try {
			const files = await readdir(this.cacheDir);
			const removals = files
				.filter((f) => f.endsWith(".json"))
				.map((f) => unlink(join(this.cacheDir, f)).catch(() => {}));
			await Promise.all(removals);
		} catch {
			// Directory may not exist yet
		}
	}

	/**
	 * Check whether a cached timestamp has exceeded the given TTL.
	 */
	isExpired(timestamp: number, ttlMs: number): boolean {
		return Date.now() - timestamp > ttlMs;
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Sanitize a cache key into a safe filename and return the full path.
	 * Replaces any character that is not alphanumeric, dash, or underscore with an underscore.
	 */
	private keyToPath(key: string): string {
		const safeKey = key.replace(/[^a-zA-Z0-9\-_]/g, "_");
		return join(this.cacheDir, `${safeKey}.json`);
	}

	/**
	 * Ensure the cache directory exists, creating it recursively if needed.
	 */
	private async ensureDir(): Promise<void> {
		await mkdir(this.cacheDir, { recursive: true });
	}
}
