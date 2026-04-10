/**
 * cli-help.ts — Help text, version display, and branded splash screen.
 *
 * Extracted from `cli-commands.ts` to keep each module under 450 LOC.
 *
 * @module cli-help
 */

import {
	BOLD, CYAN, DIM, GREEN, MAGENTA, RED, YELLOW,
	c,
} from "./cli-format.js";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const VERSION = (_require("../package.json") as { version: string }).version;

// ── help & version ───────────────────────────────────────────────────────

/** Print the full CLI usage / help text to stdout. */
export function showHelp(): void {
	console.log(`
${c(BOLD, "kosha")} ${c(DIM, "\u2014 AI Model & Provider Discovery Registry")}

${c(BOLD, "USAGE")}
  kosha <command> [options]

${c(BOLD, "COMMANDS")}
  ${c(CYAN, "discover")}                      Discover all providers and models
  ${c(CYAN, "list")}                          List all known models
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by origin/creator provider (e.g. anthropic)
    --mode <mode>                 Filter by mode (chat, embedding, image, audio)
    --capability <cap>            Filter by capability (vision, function_calling, etc.)
  ${c(CYAN, "search")} <query>                Search models by name/ID (fuzzy match)
    --origin <name>               Restrict search to a specific origin provider
  ${c(CYAN, "model")} <id|alias>              Show detailed info for one model
  ${c(CYAN, "roles")}                         Show provider -> model -> roles matrix
    --role <role>                 Filter by task role (e.g. embeddings, image, tool_use)
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by model creator provider
    --mode <mode>                 Filter by mode (chat, embedding, image, audio, moderation)
    --capability <cap>            Filter by capability tag
  ${c(CYAN, "capabilities")} ${c(DIM, "(caps)")}             Show all capabilities across the ecosystem
    --provider <name>             Scope to one provider
  ${c(CYAN, "capable")} <capability>            List models with a given capability
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by origin/creator provider
    --mode <mode>                 Filter by mode (chat, embedding, image, audio)
    --limit <n>                   Maximum models to show
  ${c(CYAN, "cheapest")}                      Find cheapest eligible models
    --role <role>                 Task role, e.g. embeddings or image
    --capability <cap>            Capability filter (vision, embedding, function_calling)
    --mode <mode>                 Mode filter
    --limit <n>                   Maximum matches to return (default 5)
    --price-metric <metric>       input | output | blended
    --input-weight <n>            Weight for blended metric input price
    --output-weight <n>           Weight for blended metric output price
    --include-unpriced            Include unpriced models after ranked matches
  ${c(CYAN, "routes")} <id|alias>             Show all provider routes for a model
  ${c(CYAN, "providers")}                     List all providers and their status
  ${c(CYAN, "resolve")} <alias>               Resolve an alias to canonical model ID
  ${c(CYAN, "latest")}                        Force-fetch latest model/provider details
    --provider <name>             Scope latest fetch to one provider
  ${c(CYAN, "refresh")} ${c(DIM, "(update)")}              Force re-discover all providers (bypass cache)
    --provider <name>             Refresh only one provider
  ${c(CYAN, "serve")} [--port 3000]           Start HTTP API server

${c(BOLD, "CACHING & OUTPUT")}
  Results are cached at ${c(CYAN, "~/.kosha/cache")} for 24h by default.
  Subsequent ${c(CYAN, "kosha list")}, ${c(CYAN, "search")}, etc. load instantly from disk.
  Run ${c(CYAN, "kosha update")} to force a fresh pull from all provider APIs.

  A stable, third-party-readable manifest is also written to
    ${c(CYAN, "~/.kosha/registry.json")}
  after every discover / update, containing the full v1 snapshot
  (providers, models, pricing, capabilities, health). Any language or
  tool that can read JSON can consume it directly.

${c(BOLD, "OPTIONS")}
  --json                          Output as JSON (works with any command)
  --help                          Show this help message
  --version                       Show version

${c(BOLD, "EXAMPLES")}
  ${c(DIM, "$")} kosha discover
  ${c(DIM, "$")} kosha list --provider anthropic
  ${c(DIM, "$")} kosha list --origin anthropic
  ${c(DIM, "$")} kosha list --mode embedding --json
  ${c(DIM, "$")} kosha search gemini
  ${c(DIM, "$")} kosha search claude --origin anthropic
  ${c(DIM, "$")} kosha model sonnet
  ${c(DIM, "$")} kosha roles --role embeddings
  ${c(DIM, "$")} kosha capabilities
  ${c(DIM, "$")} kosha capable vision
  ${c(DIM, "$")} kosha capable embeddings --limit 5
  ${c(DIM, "$")} kosha cheapest --role image --limit 3
  ${c(DIM, "$")} kosha routes claude-opus-4-6
  ${c(DIM, "$")} kosha routes gpt-4o --json
  ${c(DIM, "$")} kosha providers
  ${c(DIM, "$")} kosha latest
  ${c(DIM, "$")} kosha latest --provider openai --json
  ${c(DIM, "$")} kosha resolve haiku
  ${c(DIM, "$")} kosha refresh --provider anthropic
  ${c(DIM, "$")} kosha serve --port 8080
`.trim());
}

/** Print the CLI version string to stdout. */
export function showVersion(): void {
	console.log(`kosha-discovery v${VERSION}`);
}

/**
 * Display a branded splash screen when `kosha` is invoked with no arguments.
 *
 * Shows the Kosha logo, tagline, version, and quick-start commands.
 * Uses MAGENTA branding with a clean, minimal layout.
 */
export function showSplash(): void {
	const brandWord =
		`${c(CYAN, "k")}${c(GREEN, "o")}${c(YELLOW, "s")}${c(MAGENTA, "h")}${c(RED, "a")}`;
	const mascot1 = `${c(CYAN, " /\\_/\\ ")} ${c(DIM, "assistant mascot")}`;
	const mascot2 = `${c(CYAN, "( o.o )")} ${c(DIM, "ready to route")}`;
	const mascot3 = `${c(CYAN, " > ^ < ")} ${c(DIM, "providers + models")}`;

	console.log(`
${c(MAGENTA, "  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557")}
${c(MAGENTA, "  \u2551")}                                                   ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}   ${c(BOLD, "  \u2588\u2584\u2580 \u2588\u2580\u2588 \u2588\u2580 \u2588 \u2588 \u2584\u2580\u2588")}                         ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}   ${c(BOLD, "  \u2588 \u2588 \u2588\u2584\u2588 \u2584\u2588 \u2588\u2580\u2588 \u2588\u2580\u2588")}    ${c(DIM, "\u0915\u094B\u0936 \u2014 treasury")}        ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}                                                   ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}   ${brandWord} ${c(DIM, "AI Model & Provider Discovery Registry")}  ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}   ${c(DIM, `v${VERSION}`)}                                          ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}   ${mascot1}                                ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}   ${mascot2}                                ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}   ${mascot3}                                ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u2551")}                                                   ${c(MAGENTA, "\u2551")}
${c(MAGENTA, "  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D")}

  ${c(BOLD, "Quick start:")}

    ${c(CYAN, "kosha discover")}       Scan all providers for models
    ${c(CYAN, "kosha list")}           List all discovered models
    ${c(CYAN, "kosha search")} ${c(DIM, "<q>")}     Search by name or ID
    ${c(CYAN, "kosha model")} ${c(DIM, "<id>")}     Detailed info for one model
    ${c(CYAN, "kosha capabilities")}   What capabilities exist?
    ${c(CYAN, "kosha capable")} ${c(DIM, "<cap>")}  Models with a given capability
    ${c(CYAN, "kosha roles")}          Provider -> model -> roles matrix
    ${c(CYAN, "kosha cheapest")}       Cheapest models for a role
    ${c(CYAN, "kosha routes")} ${c(DIM, "<id>")}    All provider routes for a model
    ${c(CYAN, "kosha providers")}      Show provider status
    ${c(CYAN, "kosha latest")}         Force-fetch latest provider/model details
    ${c(CYAN, "kosha serve")}          Start the HTTP API server

  ${c(DIM, "Run")} ${c(CYAN, "kosha --help")} ${c(DIM, "for full usage.")}
`);
}
