# kosha-discovery — कोश

**AI Model & Provider Discovery Registry**

![Kosha mini cute app](docs/kosha-mini-cute-mascot.svg)

Kosha (कोश — treasury/repository) automatically discovers AI models across providers, resolves credentials from CLI tools and environment variables, enriches models with pricing data, and exposes the catalog via library, CLI, and HTTP API.

## Why

AI applications hardcode model IDs, pricing, and provider configs. When providers add models or change pricing, every app breaks. Kosha solves this:

- **Dynamic discovery** — fetches real model lists from provider APIs
- **Smart credentials** — finds API keys from env vars, CLI tools (Claude, Copilot, Gemini CLI), and config files
- **Pricing enrichment** — fills in costs and context windows from litellm's community-maintained dataset
- **Model aliases** — `sonnet` → `claude-sonnet-4-20250514`, updated as models evolve
- **Role matrix** — query provider -> model -> roles (`chat`, `embedding`, `image_generation`, etc.)
- **Cheapest routing** — rank cheapest eligible models for tasks like embeddings or image generation
- **Credential prompts** — returns provider-specific API key hints when required credentials are missing
- **Local LLM scanning** — detects Ollama models alongside cloud providers
- **Three access patterns** — use as a library, CLI tool, or HTTP API

## Install

```bash
npm install kosha-discovery
# or
pnpm add kosha-discovery
```

## Quick Start

### Library

```typescript
import { createKosha } from "kosha-discovery";

const kosha = await createKosha();

// List all models
const models = kosha.models();

// Filter by provider
const anthropicModels = kosha.models({ provider: "anthropic" });

// Get embedding models
const embeddings = kosha.models({ mode: "embedding" });

// Resolve alias
const model = kosha.model("sonnet"); // → full ModelCard for claude-sonnet-4-20250514

// Get pricing
console.log(model.pricing); // { inputPerMillion: 3, outputPerMillion: 15, ... }

// Role matrix for assistants (provider -> models -> roles)
const roles = kosha.providerRoles({ role: "embeddings" });

// Cheapest model ranking for a task
const cheapest = kosha.cheapestModels({ role: "image", limit: 3 });
console.log(cheapest.matches[0]);
```

### CLI

```bash
# Discover all providers
kosha discover

# List models
kosha list
kosha list --provider anthropic
kosha list --mode embedding

# Search
kosha search gemini

# Model details
kosha model sonnet

# Role matrix
kosha roles
kosha roles --role embeddings

# Cheapest routing candidates
kosha cheapest --role embeddings
kosha cheapest --role image --limit 3

# Providers status
kosha providers

# Resolve alias
kosha resolve haiku

# Start API server
kosha serve --port 3000
```

### HTTP API

```bash
kosha serve --port 3000
```

```
GET /api/models                    — All models
GET /api/models?provider=anthropic — Filter by provider
GET /api/models?mode=embedding     — Filter by mode
GET /api/models/cheapest           — Cheapest ranked models for a role/capability
GET /api/models/:idOrAlias         — Single model
GET /api/models/:idOrAlias/routes  — All provider routes for one model
GET /api/roles                     — Provider → model → roles matrix
GET /api/providers                 — All providers
GET /api/providers/:id             — Single provider
POST /api/refresh                  — Re-discover
GET /api/resolve/:alias            — Resolve alias
GET /health                        — Health check
```

## Assistant Routing Flow

Kosha is designed to answer routing questions from assistants like Vaayu and Takumi:

1. Ask for capabilities: call `GET /api/roles?role=embeddings`.
2. Rank by cost: call `GET /api/models/cheapest?role=embeddings`.
3. If `missingCredentials` is non-empty, prompt the user for one of the listed env vars.
4. Route execution using the chosen provider/model pair.

### Embeddings Quick Call

If your task is embeddings and you want the cheapest option:

```bash
kosha cheapest --role embeddings --price-metric input --limit 1
```

API equivalent:

```bash
curl "http://localhost:3000/api/models/cheapest?role=embeddings&priceMetric=input&limit=1"
```

## Provider vs Origin

Kosha distinguishes:

- `provider`: where you call the model (serving layer, e.g. `openrouter`)
- `originProvider`: who built the model (e.g. `openai`)

Example:

```
provider: openrouter
id: openai/gpt-5.3-codex
originProvider: openai
```

If a direct OpenAI route exists, route metadata marks it as preferred so assistants can call `openai` directly instead of `openrouter`.

## CLI Reference

```
USAGE
  kosha <command> [options]

COMMANDS
  discover                      Discover all providers and models
  list                          List all known models
    --provider <name>             Filter by provider
    --mode <mode>                 Filter by mode (chat, embedding, image, audio)
    --capability <cap>            Filter by capability (vision, function_calling, etc.)
  roles                         Provider -> model -> roles matrix
    --role <role>                 Filter by task role (embeddings, image, tool_use)
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by origin model provider
    --mode <mode>                 Filter by mode
    --capability <cap>            Filter by capability
  cheapest                      Find cheapest eligible models
    --role <role>                 Task role (embeddings, image, etc.)
    --capability <cap>            Capability filter
    --mode <mode>                 Mode filter
    --limit <n>                   Maximum matches (default 5)
    --price-metric <metric>       input | output | blended
    --input-weight <n>            Blended metric input weight
    --output-weight <n>           Blended metric output weight
    --include-unpriced            Include models without pricing at end
  search <query>                Search models by name/ID (fuzzy match)
  model <id|alias>              Show detailed info for one model
  providers                     List all providers and their status
  resolve <alias>               Resolve an alias to canonical model ID
  refresh                       Force re-discover all providers (bypass cache)
  serve [--port 3000]           Start HTTP API server

OPTIONS
  --json                          Output as JSON (works with any command)
  --help                          Show this help message
  --version                       Show version
```

### Example: `kosha list`

```
Provider     Model                              Mode       Context    $/M in   $/M out
──────────── ────────────────────────────────── ────────── ────────── ──────── ────────
anthropic    claude-opus-4-20250918             chat       200K       $15.00   $75.00
anthropic    claude-sonnet-4-20250514           chat       200K       $3.00    $15.00
anthropic    claude-haiku-4-5-20251001          chat       200K       $0.80    $4.00
openai       gpt-4o                             chat       128K       $2.50    $10.00
openai       text-embedding-3-small             embedding  8K         $0.02    —
google       gemini-2.5-pro-preview-05-06       chat       1M         $1.25    $10.00
ollama       qwen3:8b                           chat       —          free     free
───────────────────────────────────────────────────────────────────────────────────────
42 models from 4 providers
```

### Example: `kosha model sonnet`

```
Model: claude-sonnet-4-20250514
Provider: Anthropic
Mode: chat
Aliases: sonnet, sonnet-4
Context Window: 200,000 tokens
Max Output: 16,384 tokens
Capabilities: chat, vision, function_calling, code, nlu
Pricing: $3.00 / $15.00 per million tokens (in/out)
Source: api + litellm
Discovered: 2026-02-26T10:30:00Z
```

### Example: `kosha providers`

```
Provider     Status          Models  Credential Source
──────────── ─────────────── ─────── ─────────────────
anthropic    ✓ authenticated     12  env (ANTHROPIC_API_KEY)
openai       ✓ authenticated      8  cli (~/.config/github-copilot)
google       ✓ authenticated     15  env (GOOGLE_API_KEY)
ollama       ✓ local              6  none (local)
openrouter   ✗ no credentials     0  —
```

### Example: `kosha roles --role embeddings`

```
Provider     Model                                   Mode       Roles
──────────── ─────────────────────────────────────── ────────── ───────────────────────────────
openai       text-embedding-3-small                  embedding  embedding
google       text-embedding-004                      embedding  embedding
```

### Example: `kosha cheapest --role image --limit 2`

```
Provider     Model                                   Mode       Metric      Score    $/M in  $/M out
──────────── ─────────────────────────────────────── ────────── ──────── ────────── ──────── ────────
openrouter   openai/dall-e-3                         image      blended     $8.00    $8.00    $0.00
openrouter   black-forest-labs/flux-1-schnell        image      blended    $10.00   $10.00    $0.00
```

## HTTP API Reference

Start the server:

```bash
kosha serve --port 3000
# or
PORT=3000 node dist/server.js
```

### Endpoints

#### `GET /api/models`

List all discovered models. Supports query parameters for filtering.

| Parameter    | Type   | Description                                |
|-------------|--------|--------------------------------------------|
| `provider`  | string | Filter by provider ID (e.g., `anthropic`)  |
| `mode`      | string | Filter by mode (`chat`, `embedding`, etc.) |
| `capability`| string | Filter by capability (`vision`, etc.)      |

```bash
curl http://localhost:3000/api/models?provider=anthropic&mode=chat
```

```json
{
  "models": [ ... ],
  "count": 12
}
```

#### `GET /api/models/cheapest`

Rank the cheapest eligible models for a role/capability.  
Useful for assistant routers asking questions like: _"For embeddings, what is cheapest right now?"_

| Parameter         | Type   | Description |
|------------------|--------|-------------|
| `role`           | string | Flexible role alias (e.g. `embeddings`, `image`, `tool_use`) |
| `capability`     | string | Explicit capability (e.g. `vision`, `embedding`) |
| `mode`           | string | Restrict by mode (`chat`, `embedding`, `image`, `audio`, `moderation`) |
| `provider`       | string | Restrict by serving provider |
| `originProvider` | string | Restrict by origin model provider |
| `limit`          | number | Max ranked matches (default `5`) |
| `priceMetric`    | string | `input`, `output`, or `blended` |
| `inputWeight`    | number | Input weight for `blended` scoring |
| `outputWeight`   | number | Output weight for `blended` scoring |
| `includeUnpriced`| bool   | Include unpriced models after ranked matches |

```bash
curl "http://localhost:3000/api/models/cheapest?role=embeddings&limit=3"
```

```json
{
  "matches": [
    {
      "model": { "id": "text-embedding-3-small", "provider": "openai", "...": "..." },
      "score": 0.02,
      "priceMetric": "input"
    }
  ],
  "candidates": 6,
  "pricedCandidates": 4,
  "skippedNoPricing": 2,
  "priceMetric": "input",
  "missingCredentials": [
    {
      "providerId": "google",
      "providerName": "Google",
      "envVars": ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
      "message": "Set GOOGLE_API_KEY or GEMINI_API_KEY to enable Google model discovery."
    }
  ],
  "cheapest": {
    "model": { "id": "text-embedding-3-small", "provider": "openai", "...": "..." },
    "score": 0.02,
    "priceMetric": "input"
  }
}
```

#### `GET /api/roles`

Return a provider -> model -> roles matrix.

```bash
curl "http://localhost:3000/api/roles?role=image"
```

```json
{
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "authenticated": false,
      "credentialSource": "none",
      "models": [
        {
          "id": "openai/dall-e-3",
          "mode": "image",
          "roles": ["image", "image_generation"]
        }
      ]
    }
  ],
  "count": 1,
  "modelCount": 12,
  "missingCredentials": []
}
```

#### `GET /api/models/:idOrAlias`

Get a single model by its full ID or alias, including resolved provider URL and version hint.

```bash
curl http://localhost:3000/api/models/sonnet
```

```json
{
  "id": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "originProvider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "version": "20250514",
  "resolvedOriginProvider": "anthropic",
  "isDirectProvider": true
}
```

#### `GET /api/models/:idOrAlias/routes`

Return all serving routes for one underlying model with direct/preferred flags.

```bash
curl http://localhost:3000/api/models/gpt-5.3-codex/routes
```

```json
{
  "model": "gpt-5.3-codex",
  "preferredProvider": "openai",
  "routes": [
    {
      "provider": "openai",
      "originProvider": "openai",
      "baseUrl": "https://api.openai.com",
      "version": "5.3",
      "isDirect": true,
      "isPreferred": true,
      "model": { "...": "..." }
    },
    {
      "provider": "openrouter",
      "originProvider": "openai",
      "baseUrl": "https://openrouter.ai",
      "version": "5.3",
      "isDirect": false,
      "isPreferred": false,
      "model": { "...": "..." }
    }
  ]
}
```

#### `GET /api/providers`

List all providers with summary info.

```bash
curl http://localhost:3000/api/providers
```

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authenticated": true,
      "credentialSource": "env",
      "modelCount": 12,
      "lastRefreshed": 1740000000000,
      "missingCredentialPrompt": null,
      "credentialEnvVars": []
    }
  ],
  "count": 4,
  "missingCredentials": []
}
```

#### `GET /api/providers/:id`

Get a single provider with all its models.

```bash
curl http://localhost:3000/api/providers/anthropic
```

#### `POST /api/refresh`

Trigger re-discovery of all providers, or a specific one.

```bash
# Refresh all
curl -X POST http://localhost:3000/api/refresh

# Refresh a specific provider
curl -X POST http://localhost:3000/api/refresh -H "Content-Type: application/json" -d '{"provider": "anthropic"}'
```

#### `GET /api/resolve/:alias`

Resolve a model alias to its canonical ID.

```bash
curl http://localhost:3000/api/resolve/sonnet
```

```json
{
  "alias": "sonnet",
  "resolved": "claude-sonnet-4-20250514",
  "isAlias": true
}
```

#### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "models": 42,
  "providers": 4,
  "uptime": 123.45
}
```

## Supported Providers

| Provider | Discovery | Credential Sources |
|----------|-----------|-------------------|
| Anthropic | API (`/v1/models`) | `ANTHROPIC_API_KEY`, Claude CLI, Codex CLI |
| OpenAI | API (`/v1/models`) | `OPENAI_API_KEY`, GitHub Copilot tokens |
| Google | API (`/v1beta/models`) | `GOOGLE_API_KEY`, `GEMINI_API_KEY`, Gemini CLI, gcloud |
| Ollama | Local API (`/api/tags`) | None needed (local) |
| OpenRouter | API (`/api/v1/models`) | `OPENROUTER_API_KEY` |

## Model Aliases

Built-in aliases for common models:

| Alias | Resolves To |
|-------|-------------|
| `sonnet` | `claude-sonnet-4-20250514` |
| `opus` | `claude-opus-4-20250918` |
| `haiku` | `claude-haiku-4-5-20251001` |
| `gpt4o` | `gpt-4o` |
| `gemini-pro` | `gemini-2.5-pro-preview-05-06` |
| `embed-small` | `text-embedding-3-small` |
| `nomic` | `nomic-embed-text` |

Custom aliases:

```typescript
import { ModelRegistry } from "kosha-discovery";
const registry = new ModelRegistry({ aliases: { "fast": "claude-haiku-4-5-20251001" } });
```

## Configuration

```typescript
const registry = new ModelRegistry({
  cacheDir: "~/.kosha",           // Cache directory (default: ~/.kosha)
  cacheTtlMs: 86400000,           // Cache TTL: 24 hours (default)
  providers: {
    anthropic: { enabled: true, apiKey: "sk-..." },
    ollama: { enabled: true, baseUrl: "http://localhost:11434" },
    openrouter: { enabled: false },
  },
  aliases: {
    "my-model": "claude-sonnet-4-20250514",
  },
});
```

## Pricing Enrichment

Model pricing is sourced from [litellm's model pricing database](https://github.com/BerriAI/litellm) -- a community-maintained dataset covering 300+ models. Kosha fetches this data and enriches discovered models with:

- Input/output token pricing
- Context window sizes
- Cache read/write costs
- Capability flags (vision, function calling, etc.)

## Architecture

```
┌─────────────────────────────────────────┐
│          Your Application               │
│  import { createKosha } from "kosha"    │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│            ModelRegistry                │
│ models() · providerRoles() · cheapestModels() │
└───┬────────────┬────────────────┬───────┘
    │            │                │
┌───▼──┐  ┌─────▼─────┐  ┌──────▼──────┐
│Alias │  │ Discovery  │  │ Enrichment  │
│System│  │ Layer      │  │ Layer       │
└──────┘  └─────┬──────┘  └──────┬──────┘
          ┌─────┼──────┐         │
          ▼     ▼      ▼         ▼
       Anthropic OpenAI Google  litellm
       Ollama   OpenRouter       JSON
```

## Project Structure

```
src/
  types.ts              Type definitions (ModelCard, ProviderInfo, etc.)
  registry.ts           ModelRegistry class — core orchestrator
  cli.ts                CLI entry point (process.argv parser)
  server.ts             HTTP API server (Hono)
  discovery/
    base.ts             Abstract base discoverer
    anthropic.ts        Anthropic API discoverer
    openai.ts           OpenAI API discoverer
    google.ts           Google Gemini API discoverer
    ollama.ts           Ollama local discoverer
    openrouter.ts       OpenRouter API discoverer
    index.ts            Discovery orchestrator
  credentials/
    resolver.ts         Credential resolver (env, CLI, config)
    index.ts            Credential resolver entry
  enrichment/
    litellm.ts          litellm pricing enrichment
    index.ts            Enrichment entry
bin/
  kosha.js              CLI bin entry point
```

## Credits & Inspiration

- **[litellm](https://github.com/BerriAI/litellm)** -- Community-maintained model pricing database. Kosha uses their `model_prices_and_context_window.json` for enrichment.
- **[openrouter](https://openrouter.ai)** -- Model aggregation API providing rich model metadata.
- **[ollama](https://ollama.ai)** -- Local LLM runtime with model discovery API.
- **[chitragupta](https://github.com/sriinnu/chitragupta)** -- Autonomous AI Agent Platform whose provider registry patterns inspired kosha's design.
- **[takumi](https://github.com/sriinnu/takumi)** -- AI coding agent TUI whose model routing needs drove kosha's creation.

## Part of Kaala-brahma

Kosha is a standalone utility in the [Kaala-brahma](https://github.com/sriinnu/Kaala-brahma) ecosystem -- powering model discovery for Takumi (coding agent), Chitragupta (autonomous agents), and other AI applications.

## License

MIT
