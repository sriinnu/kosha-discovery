/**
 * kosha-discovery — "am I the process entry point?" helper.
 *
 * `import.meta.url === \`file://${process.argv[1]}\`` breaks on symlinked bins
 * (global npm installs point argv[1] at the link, import.meta.url at the
 * target), relative invocations, and paths with spaces. Resolving argv[1]
 * through realpath + pathToFileURL handles all three, and the try/catch keeps
 * test runners (which import the module without argv[1] pointing at it) from
 * ever starting a server or a stdio loop.
 * @module
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** True when the module at `importMetaUrl` is the script Node was asked to run. */
export function isMainModule(importMetaUrl: string): boolean {
	try {
		const entry = process.argv[1];
		if (!entry) return false;
		return importMetaUrl === pathToFileURL(realpathSync(entry)).href;
	} catch {
		return false;
	}
}
