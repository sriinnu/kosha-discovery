<p align="center">
  <img src="logo.svg" alt="Kosha — AI Model Discovery" width="140" />
</p>

<h1 align="center">kosha-discovery — कोश</h1>

<p align="center"><strong>AI Model & Provider Discovery Registry</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/kosha-discovery"><img src="https://img.shields.io/npm/v/kosha-discovery?color=7C3AED&label=npm" alt="npm version" /></a>
  <a href="https://github.com/sriinnu/kosha-discovery/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/kosha-discovery?color=F59E0B" alt="license" /></a>
  <img src="https://img.shields.io/node/v/kosha-discovery?color=5B21B6" alt="node version" />
</p>

Kosha (कोश — treasury/repository) automatically discovers AI models across providers, resolves credentials from CLI tools and environment variables, enriches models with pricing data, and exposes the catalog via library, CLI, and HTTP API.

## Why

AI applications hardcode model IDs, pricing, and provider configs. When providers add models or change pricing, every app breaks. Kosha solves this:

- **Dynamic discovery** — fetches real model lists from provider APIs
- **Smart credentials** — finds API keys from env vars, CLI tools (Claude, Copilot, Gemini CLI), and config files
- **Pricing enrichment** — fills in costs and context windows from litellm's community-maintained dataset
- **Persistent cache + portable manifest** — 24h on-disk cache at `~/.kosha/cache`, plus a stable v1 JSON manifest at `~/.kosha/registry.json` that any language or tool can read directly
- **Model aliases** — `sonnet` → `claude-sonnet-4-20250514`, updated as models evolve
- **Role matrix** — query provider -> model -> roles (`chat`, `embedding`, `image_generation`, etc.)
- **Cheapest routing** — rank cheapest eligible models for tasks like embeddings or image generation
- **Local LLM scanning** — detects Ollama models alongside cloud providers
- **Three access patterns** — use as a library, CLI tool, or HTTP API

## Install

```bash
npm install kosha-discovery      # library or HTTP server
npm install -g kosha-discovery   # global `kosha` CLI
```

## Getting Started (CLI)

```bash
# 1. First run — discovers all reachable providers and writes the cache + manifest
kosha discover
# → Anthropic: 3 models, OpenAI: 7 models, ...
# → Cached to ~/.kosha/cache  ·  Manifest: ~/.kosha/registry.json

# 2. Subsequent commands read instantly from the 24h on-disk cache
kosha list
# → Loaded 380 models from cache (9h ago). Run "kosha update" to refresh.

# 3. Force a fresh pull from all provider APIs
kosha update     # alias for `kosha refresh`
```

After any discovery, a **stable, third-party-readable manifest** is written to
`~/.kosha/registry.json`. It holds the full v1 snapshot — providers, models,
pricing, capabilities, and health — in a documented schema. Any tool that can
read JSON can consume it:

```bash
jq '.models[] | select(.pricing.inputPerMillion < 0.1) | .modelId' ~/.kosha/registry.json
```

```python
import json, pathlib
data = json.loads(pathlib.Path("~/.kosha/registry.json").expanduser().read_text())
print(len(data["models"]), "models from", len(data["providers"]), "providers")
```

## Quick Start

### Library

```typescript
import { createKosha } from "kosha-discovery";

const kosha = await createKosha();

const models = kosha.models();                           // all models
const embeddings = kosha.models({ mode: "embedding" });  // filter by mode
const model = kosha.model("sonnet");                     // resolve alias
const cheapest = kosha.cheapestModels({ role: "image", limit: 3 });

console.log(model.pricing); // { inputPerMillion: 3, outputPerMillion: 15, ... }
```

### CLI

```bash
kosha discover                          # discover all providers (writes cache + manifest)
kosha list                              # list models (instant from cache)
kosha list --provider anthropic         # filter by provider
kosha search gemini                     # fuzzy search
kosha model sonnet                      # model details
kosha cheapest --role embeddings        # cheapest for a task
kosha routes gpt-4o                     # all provider routes
kosha providers                         # provider status
kosha update                            # force re-discover (alias: refresh)
kosha serve --port 3000                 # start HTTP API
```

Results live at `~/.kosha/cache` (24h TTL) and `~/.kosha/registry.json` (stable
v1 manifest). See [docs/cli.md](docs/cli.md) for the full reference.

### HTTP API

```bash
kosha serve --port 3000
```

```
GET /api/models                    — All models (filterable)
GET /api/models/cheapest           — Cheapest ranked models
GET /api/models/:idOrAlias         — Single model
GET /api/models/:idOrAlias/routes  — All provider routes
GET /api/roles                     — Provider → model → roles matrix
GET /api/providers                 — All providers
POST /api/refresh                  — Re-discover
GET /health                        — Health check
```

## Supported Providers

| Provider | Discovery | Credential Sources |
|----------|-----------|-------------------|
| Anthropic | API (`/v1/models`) | `ANTHROPIC_API_KEY`, Claude CLI, Codex CLI |
| OpenAI | API (`/v1/models`) | `OPENAI_API_KEY`, GitHub Copilot tokens |
| Google | API (`/v1beta/models`) | `GOOGLE_API_KEY`, `GEMINI_API_KEY`, Gemini CLI, gcloud |
| AWS Bedrock | SDK → CLI → static | `AWS_ACCESS_KEY_ID`, `~/.aws/credentials`, SSO, IAM |
| Vertex AI | API + gcloud | `GOOGLE_APPLICATION_CREDENTIALS`, gcloud ADC |
| Ollama | Local API | None needed (local) |
| OpenRouter | API | `OPENROUTER_API_KEY` (optional) |
| NVIDIA | API | `NVIDIA_API_KEY` |
| Together AI | API | `TOGETHER_API_KEY` |
| Fireworks AI | API | `FIREWORKS_API_KEY` |
| Groq | API | `GROQ_API_KEY` |
| Mistral AI | API | `MISTRAL_API_KEY` |
| DeepInfra | API | `DEEPINFRA_API_KEY` |
| Cohere | API | `CO_API_KEY` |
| Cerebras | API | `CEREBRAS_API_KEY` |
| Perplexity | API | `PERPLEXITY_API_KEY` |

## Security

All external data (API responses, CLI output, cache reads) is scanned for 9 threat types before use: credential leaks, base64 payloads, script/shell injection, data URIs, null bytes, prototype pollution, hex blobs, and oversized strings. A pre-commit hook blocks secrets at commit time.

See [docs/security.md](docs/security.md) for the full threat catalogue and architecture.

## Architecture

<p align="center">
  <img src="architecture.svg" alt="Kosha Architecture" width="720" />
</p>

```
┌─────────────────────────────────────────────────────┐
│                  Your Application                    │
│        import { createKosha } from "kosha"          │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│                  ModelRegistry                        │
│  models() · providerRoles() · cheapestModels()       │
└──┬──────────┬──────────────┬───────────────┬────────┘
   │          │              │               │
┌──▼───┐ ┌───▼────────┐ ┌───▼──────────┐ ┌──▼─────────┐
│Alias │ │ Discovery   │ │ Enrichment   │ │ Resilience  │
│System│ │ Layer       │ │ Layer        │ │ Layer       │
└──────┘ └───┬────────┘ └──────┬───────┘ └────────────┘
             │                 │          CircuitBreaker
    ┌────────┼────────┐        │          HealthTracker
    ▼        ▼        ▼        ▼          StaleCachePolicy
 Direct   OpenAI-   Cloud      litellm
  API    Compatible  Proxies    JSON
```

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Credentials](docs/credentials.md) | Setup for all 16 providers (env vars, CLI tools, config files) |
| [CLI Reference](docs/cli.md) | All commands, flags, and example output |
| [HTTP API](docs/api.md) | All endpoints, parameters, and response schemas |
| [Configuration](docs/configuration.md) | Aliases, routing, pricing enrichment, programmatic config |
| [Architecture](docs/architecture.md) | Discovery flow, module map, data pipeline, adding providers |
| [Resilience](docs/resilience.md) | Circuit breakers, stale cache fallback, health monitoring |
| [Security](docs/security.md) | Threat catalogue, runtime scanning, pre-commit hook |
| [Discovery Plane v1](docs/discovery-plane-v1.md) | Stable daemon contract (deltas, SSE watch, binding hints) |

## Credits

- **[litellm](https://github.com/BerriAI/litellm)** -- Community-maintained model pricing database
- **[openrouter](https://openrouter.ai)** -- Model aggregation API
- **[ollama](https://ollama.ai)** -- Local LLM runtime
- **[chitragupta](https://github.com/sriinnu/chitragupta)** -- Autonomous AI Agent Platform whose registry patterns inspired kosha
- **[takumi](https://github.com/sriinnu/takumi)** -- AI coding agent TUI whose routing needs drove kosha's creation

## What "Kosha" Means

`Kosha` comes from Sanskrit -- a container, treasury, or layered sheath of knowledge. A standalone model-discovery utility for any AI system.

## License

MIT
