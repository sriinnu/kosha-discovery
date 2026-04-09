#!/usr/bin/env node

import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";

const DEFAULT_INTERVAL_SECONDS = 3600;
const DEFAULT_OUTPUT = "./data/kosha-latest.json";

function parseArgs(argv) {
	const args = {
		once: false,
		intervalSeconds: DEFAULT_INTERVAL_SECONDS,
		output: DEFAULT_OUTPUT,
		provider: undefined,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--once") {
			args.once = true;
			continue;
		}
		if (token === "--interval-seconds") {
			const raw = argv[i + 1];
			i += 1;
			const parsed = Number(raw);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid --interval-seconds value: ${raw}`);
			}
			args.intervalSeconds = parsed;
			continue;
		}
		if (token === "--provider") {
			args.provider = argv[i + 1];
			i += 1;
			continue;
		}
		if (token === "--output") {
			args.output = argv[i + 1];
			i += 1;
			continue;
		}
	}

	return args;
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runOnce(args) {
	const { ModelRegistry } = await import("../dist/index.js");
	const registry = new ModelRegistry();
	const result = await registry.fetchLatestDetails({
		providers: args.provider ? [args.provider] : undefined,
	});

	const payload = {
		fetchedAt: new Date().toISOString(),
		providerScope: args.provider ?? "all",
		modelCount: result.modelCount,
		providerCount: result.providers.length,
		discoveredAt: result.discoveredAt,
		providers: result.providers,
	};

	const outputPath = resolve(args.output);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

	process.stdout.write(
		`[auto-fetch] wrote ${payload.modelCount} models from ${payload.providerCount} providers -> ${outputPath}\n`,
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.once) {
		await runOnce(args);
		return;
	}

	process.stdout.write(
		`[auto-fetch] starting loop (interval=${args.intervalSeconds}s, provider=${args.provider ?? "all"}, output=${resolve(args.output)})\n`,
	);

	while (true) {
		try {
			await runOnce(args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[auto-fetch] fetch failed: ${message}\n`);
		}
		await sleep(args.intervalSeconds * 1000);
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
});

