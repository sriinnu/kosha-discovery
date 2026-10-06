#!/usr/bin/env node
/**
 * Build the GitHub wiki from the repository's docs.
 *
 * `docs/` is the source of truth. This mirrors it into a checkout of the wiki
 * repository so the same pages are browsable there, without a second copy that
 * someone has to remember to update.
 *
 * Three kinds of page, with different ownership:
 *
 *   mirrored — generated from `docs/*.md`, `SKILL.md` and `CHANGELOG.md` on
 *              every run. Edits made in the wiki UI are overwritten; change the
 *              source file instead. Tracked in `.mirrored` so a page whose
 *              source was deleted is removed, and nothing else ever is.
 *   seeded   — copied from `wiki/seed/` only when the wiki has no page of that
 *              name. After that they belong to the wiki and are never touched.
 *   foreign  — anything else in the wiki. Left alone, and listed in the sidebar.
 *
 * Usage: node scripts/build-wiki.mjs <wiki-checkout-dir> [--repo owner/name] [--ref main]
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const outDir = args.find((arg) => !arg.startsWith("--"));
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};
if (!outDir) {
	console.error("usage: build-wiki.mjs <wiki-checkout-dir> [--repo owner/name] [--ref main]");
	process.exit(2);
}
const repo = option("repo", process.env.GITHUB_REPOSITORY ?? "sriinnu/kosha-discovery");
const ref = option("ref", "main");

/**
 * Mirrored pages, in sidebar order. `page` is the wiki page name (and file
 * name); `blurb` is the one-liner shown on Home.
 */
const MIRRORED = [
	{ source: "docs/credentials.md", page: "Credentials", blurb: "Env vars, CLI tools, and config files for every provider" },
	{ source: "docs/cli.md", page: "CLI", blurb: "Commands, flags, examples" },
	{ source: "docs/api.md", page: "HTTP-API", blurb: "Endpoints, parameters, response schemas" },
	{ source: "docs/mcp.md", page: "MCP-Server", blurb: "Tools, protocol negotiation, client setup" },
	{ source: "docs/configuration.md", page: "Configuration", blurb: "Aliases, routing, enrichment, programmatic config" },
	{ source: "docs/architecture.md", page: "Architecture", blurb: "Discovery flow, module map, adding providers" },
	{ source: "docs/resilience.md", page: "Resilience", blurb: "Circuit breakers, stale cache, health" },
	{ source: "docs/operations.md", page: "Operations", blurb: "Deployment sizing, metrics, spend ledger, recovery recipes" },
	{ source: "docs/security.md", page: "Security", blurb: "Threat catalogue, runtime scanning, pre-commit hook" },
	{ source: "docs/discovery-plane-v1.md", page: "Discovery-Plane-v1", blurb: "Stable daemon contract (deltas, SSE watch, binding hints)" },
	{ source: "SKILL.md", page: "Skill-Reference", blurb: "The whole surface on one page, written for agents" },
	{ source: "CHANGELOG.md", page: "Changelog", blurb: "What changed in each release" },
];

const RESERVED = new Set(["Home", "_Sidebar", "_Footer"]);
const MANIFEST = ".mirrored";

const blobUrl = (path) => `https://github.com/${repo}/blob/${ref}/${path}`;
const rawUrl = (path) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
const label = (page) => page.replace(/-/g, " ");

/** Repo-relative source path → wiki page name. */
const pageBySource = new Map(MIRRORED.map((entry) => [entry.source, entry.page]));

/**
 * Rewrite one link target found in `source`. Links between mirrored docs become
 * wiki links; anything else that pointed into the repository becomes an
 * absolute GitHub URL, since the wiki has no `src/` to resolve it against.
 */
function rewriteTarget(target, source, { image = false } = {}) {
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return target; // absolute, or same-page anchor
	const [path, anchor] = target.split("#");
	const resolved = posix.normalize(posix.join(posix.dirname(source), path));
	if (resolved.startsWith("..")) return target; // points outside the repository
	if (image) return rawUrl(resolved);
	const page = pageBySource.get(resolved);
	if (page) return anchor ? `${page}#${anchor}` : page;
	if (resolved === "README.md") return anchor ? `https://github.com/${repo}#${anchor}` : `https://github.com/${repo}#readme`;
	return blobUrl(resolved) + (anchor ? `#${anchor}` : "");
}

/** Rewrite Markdown links, Markdown images and `<img src>` — outside code. */
function rewriteLinks(markdown, source) {
	let fenced = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				fenced = !fenced;
				return line;
			}
			if (fenced) return line;
			// Inline code is left untouched: split on backtick runs, rewrite the rest.
			return line
				.split(/(`+[^`]*`+)/)
				.map((part) =>
					part.startsWith("`")
						? part
						: part
								.replace(
									/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
									(_, bang, text, target, title) => `${bang}[${text}](${rewriteTarget(target, source, { image: bang === "!" })}${title})`,
								)
								.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (_, pre, target, post) => `${pre}${rewriteTarget(target, source, { image: true })}${post}`),
				)
				.join("");
		})
		.join("\n");
}

/** Read a file, or return `undefined` when it does not exist — no check-then-read window. */
async function readIfPresent(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

/** Create a file only if it does not exist yet; returns whether it was created. */
async function createIfAbsent(path, content) {
	try {
		await writeFile(path, content, { flag: "wx" });
		return true;
	} catch (error) {
		if (error?.code === "EEXIST") return false;
		throw error;
	}
}

const banner = (source) =>
	`<!-- Mirrored from ${source} by scripts/build-wiki.mjs. Edits made here are overwritten; change the source file. -->\n\n`;

await mkdir(outDir, { recursive: true });

// --- mirrored pages -------------------------------------------------------
const written = [];
for (const { source, page } of MIRRORED) {
	const markdown = await readIfPresent(join(root, source));
	if (markdown === undefined) continue;
	const body = rewriteLinks(markdown, source);
	await writeFile(join(outDir, `${page}.md`), banner(source) + body.trimEnd() + "\n");
	written.push(page);
}

// Remove pages this script wrote on an earlier run whose source is gone.
// Only names from the previous manifest are candidates, so a page somebody
// created in the wiki can never be deleted from here.
const manifestPath = join(outDir, MANIFEST);
const previous = ((await readIfPresent(manifestPath)) ?? "").split("\n").filter(Boolean);
const removed = [];
for (const page of previous) {
	if (written.includes(page) || RESERVED.has(page) || !/^[\w.-]+$/.test(page)) continue;
	await rm(join(outDir, `${page}.md`), { force: true });
	removed.push(page);
}
await writeFile(manifestPath, `${written.join("\n")}\n`);

// --- seeded pages ---------------------------------------------------------
const seedDir = join(root, "wiki", "seed");
const seeded = [];
const seedFiles = await readdir(seedDir).catch((error) => {
	if (error?.code === "ENOENT") return [];
	throw error;
});
for (const file of seedFiles.filter((name) => name.endsWith(".md")).sort()) {
	if (await createIfAbsent(join(outDir, file), await readFile(join(seedDir, file), "utf8"))) {
		seeded.push(basename(file, ".md"));
	}
}

// --- navigation -----------------------------------------------------------
const mirroredNow = MIRRORED.filter((entry) => written.includes(entry.page));
const others = (await readdir(outDir))
	.filter((name) => name.endsWith(".md"))
	.map((name) => basename(name, ".md"))
	.filter((page) => !RESERVED.has(page) && !written.includes(page))
	.sort((a, b) => a.localeCompare(b));

const home = [
	"# kosha-discovery",
	"",
	"kosha tells your agent which model to use and what it costs, across AI providers and local runtimes.",
	`Install, quick start and the provider table are in the [README](https://github.com/${repo}#readme).`,
	"",
	"## Guides",
	"",
	...(others.length > 0 ? others.map((page) => `- [${label(page)}](${page})`) : ["_None yet._"]),
	"",
	"## Reference",
	"",
	"| | |",
	"|---|---|",
	...mirroredNow.map((entry) => `| [${label(entry.page)}](${entry.page}) | ${entry.blurb} |`),
	"",
	"## What changed in the catalog",
	"",
	`Each weekly snapshot's [release notes](https://github.com/${repo}/releases) list new models, repricings, deprecations and removals since the previous one.`,
	"",
	"---",
	"",
	`Reference pages are mirrored from [\`docs/\`](https://github.com/${repo}/tree/${ref}/docs) on every push to \`${ref}\` — edit them there. Guides live only in this wiki and can be edited here.`,
	"",
];
await writeFile(join(outDir, "Home.md"), home.join("\n"));

const sidebar = [
	"**[Home](Home)**",
	"",
	...(others.length > 0 ? ["**Guides**", "", ...others.map((page) => `- [${label(page)}](${page})`), ""] : []),
	"**Reference**",
	"",
	...mirroredNow.map((entry) => `- [${label(entry.page)}](${entry.page})`),
	"",
];
await writeFile(join(outDir, "_Sidebar.md"), sidebar.join("\n"));

await writeFile(
	join(outDir, "_Footer.md"),
	`Reference pages are generated from the [repository](https://github.com/${repo}); changes go through a pull request there.\n`,
);

console.log(
	`wiki: ${written.length} mirrored, ${seeded.length} seeded${seeded.length ? ` (${seeded.join(", ")})` : ""}, ` +
		`${removed.length} removed${removed.length ? ` (${removed.join(", ")})` : ""}, ${others.length} guide page(s)`,
);
