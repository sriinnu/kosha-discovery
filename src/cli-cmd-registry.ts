/**
 * `kosha registry export` — write the current catalog to a file.
 * `kosha registry accept <provider>/<model>` — accept a price quarantine holds.
 *
 * The output uses the same envelope as kosha's weekly snapshot, so it can
 * be fed straight back in as a `local` catalog
 * (`KOSHA_CATALOG_SOURCE=local KOSHA_CATALOG_FILE=<file>`), e.g. on an
 * air-gapped machine or to freeze a catalog you have reviewed.
 * @module
 */

import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCatalogEnvelope, resolveCatalogSource } from "./catalog-source.js";
import { c, DIM, GREEN, RED } from "./cli-format.js";
import type { ModelRegistry } from "./registry.js";

export async function cmdRegistry(
	registry: ModelRegistry,
	subcommand: string | undefined,
	flags: Record<string, string | boolean>,
	modelRef?: string,
): Promise<void> {
	if (subcommand === "accept") {
		await acceptHeld(registry, modelRef);
		return;
	}
	if (subcommand !== "export") {
		console.error(c(RED, `Unknown registry subcommand: "${subcommand ?? ""}"`));
		console.error(c(DIM, "Usage: kosha registry export [--output <file>] [--provider <id>]"));
		console.error(c(DIM, "       kosha registry accept <provider>/<model>"));
		process.exit(1);
	}

	const provider = typeof flags.provider === "string" ? flags.provider : undefined;
	const result = await registry.fetchLatestDetails({ providers: provider ? [provider] : undefined });
	const envelope = buildCatalogEnvelope(result.providers, {
		discoveredAt: result.discoveredAt,
		providerScope: provider ?? "all",
	});
	const json = `${JSON.stringify(envelope, null, 2)}\n`;

	if (typeof flags.output !== "string") {
		process.stdout.write(json);
		return;
	}
	// Write beside the target and rename, so a reader never sees half a file.
	const target = resolve(flags.output);
	const temp = `${target}.${process.pid}.tmp`;
	await writeFile(temp, json, { encoding: "utf8", mode: 0o644 });
	await rename(temp, target);
	console.error(
		c(GREEN, `Wrote ${envelope.modelCount} models from ${envelope.providerCount} providers`) +
			c(DIM, ` (catalog source: ${resolveCatalogSource().mode}) → ${target}`),
	);
}

/** Accept the rates a quarantine is holding for one model, after you've checked them. */
async function acceptHeld(registry: ModelRegistry, target: string | undefined): Promise<void> {
	const slash = target?.indexOf("/") ?? -1;
	if (!target || slash <= 0 || slash === target.length - 1) {
		console.error(c(RED, "Usage: kosha registry accept <provider>/<model>"));
		process.exit(1);
	}
	// Provider ids are lower-case; model ids are kept as written.
	const providerId = target.slice(0, slash).toLowerCase();
	const modelId = target.slice(slash + 1);
	const result = await registry.acceptHeldPrice(providerId, modelId);
	if (result.status === "not-found") {
		console.error(c(RED, `No ${target} in the registry manifest.`));
		process.exit(1);
	}
	if (result.status === "not-held") {
		console.error(c(DIM, `${target} has no held price; nothing to accept.`));
		return;
	}
	const since = new Date(result.waitingSince).toISOString().slice(0, 10);
	console.error(
		c(GREEN, `Accepted the price held for ${target} since ${since}.`) +
			c(DIM, " The next `kosha update` takes it; a different publish is checked afresh."),
	);
}
