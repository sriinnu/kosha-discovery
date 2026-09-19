<p align="center">
  <img src="logo.svg" alt="Kosha — AI Model Discovery" width="140" />
</p>

# kosha-discovery

**Tells your agent — or your code — which model to use and what it costs.**

kosha discovers models across 45 providers and local runtimes, finds your API keys
wherever they already live (env vars, Claude CLI, Codex, gcloud ADC, AWS SSO), fills
in pricing and context limits, and answers questions like *the cheapest model with
tool use and 128k context that I actually hold a key for*. It ships as a TypeScript
library, a CLI, an HTTP API, an OpenAI-compatible proxy with a spend ledger, and an
MCP server.

It works with no API keys at all — discovery falls back to the public models.dev and
LiteLLM catalogs, so `kosha list` is useful on a fresh machine.

## Install

```bash
npm install @sriinnu/kosha-discovery       # library / server
npm install -g @sriinnu/kosha-discovery    # global `kosha` CLI
```

Requires Node.js 22+.

## Quick start

### Library

```typescript
import { createKosha } from "@sriinnu/kosha-discovery";

const kosha = await createKosha();

const models   = kosha.models();                          // ModelCard[] across every provider
const cheapest = kosha.cheapestModels({ role: "image" }); // ranked by price, with missingCredentials
const sonnet   = kosha.model("sonnet");                   // alias → canonical ID; undefined if unknown
console.log(sonnet?.pricing); // { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, ... }
```

### CLI

```bash
kosha discover                       # query every provider; writes ~/.kosha/cache and the manifest
kosha list --provider anthropic      # read from the local cache
kosha model sonnet                   # one model, alias-aware
kosha routes claude-opus-5           # every serving route for a model (direct, OpenRouter, Bedrock, …)
kosha cheapest --role embeddings     # rank by price for a role
kosha doctor --ci                    # deprecations + provider health; non-zero exit for CI
kosha spend --since 2026-09-01       # roll up the proxy's spend ledger
kosha refresh                        # bypass the cache and re-discover
kosha serve --port 3000              # HTTP API + proxy; binds 127.0.0.1 (see Proxy below)
```

Every command takes `--json`. `kosha --help` lists the rest.

After each discovery, a stable v1 manifest lands at `~/.kosha/registry.json`:

```bash
jq '.models[] | select(.pricing.inputPerMillion < 0.1) | .modelId' ~/.kosha/registry.json
```

### Public snapshot

A weekly discovery run publishes a full snapshot — every provider, model, price
and limit kosha can see without your keys — at a stable URL:

```bash
curl -sL https://github.com/sriinnu/kosha-discovery/releases/download/snapshot-latest/kosha-latest.json \
  | jq '.modelCount, .providerCount'
```

It is a release asset rather than a file in the repository: at ~2.8 MB growing
with every provider added, committing it weekly would put roughly 150 MB of
already-stale data a year into a repo people are meant to clone. Dated
`snapshot-YYYY-MM-DD` pre-releases keep a short trail for diffing, pruned to the
two most recent, and an older one is only removed once a newer one exists.

### HTTP API

```
GET  /api/models?provider=&originProvider=&mode=&capability=
GET  /api/models/:idOrAlias             GET  /api/models/:idOrAlias/routes
GET  /api/models/cheapest?role=…        GET  /api/capabilities
GET  /api/providers[/:id]               GET  /api/roles
GET  /api/resolve/:alias                GET  /api/discovery-errors
GET  /api/discovery[/delta|/watch|/cheapest|/binding]   (stable v1 contract)
POST /api/refresh                       GET  /health          GET  /metrics
GET  /proxy/v1/models                   POST /proxy/v1/chat/completions
```

Parameters and response shapes: [docs/api.md](docs/api.md).

### Proxy

`kosha serve` also exposes an OpenAI-compatible endpoint at `/proxy/v1`. Point any OpenAI SDK at it; the proxy resolves the model or alias, picks a provider you hold credentials for, injects the upstream key, forwards the request, and writes a row to the spend ledger.

```bash
kosha serve   # start on :3000
```

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/proxy/v1",
  apiKey:  "not-used",   // kosha resolves credentials from env
});

// Use any canonical model ID or alias
const res = await client.chat.completions.create({
  model: "sonnet",
  messages: [{ role: "user", content: "hello" }],
});

// Let kosha pick the cheapest model you have a key for
const cheap = await client.chat.completions.create({
  model: "kosha:cheapest",
  messages: [{ role: "user", content: "hello" }],
});

// Cheapest model with tool_use and at least 128k context
const routed = await client.chat.completions.create({
  model: "kosha:cheapest[tool_use,128k]",
  messages: [{ role: "user", content: "hello" }],
});
```

**`kosha:cheapest` filter syntax** (comma-separated, combinable):

| Filter | Example | Meaning |
|--------|---------|---------|
| capability | `tool_use`, `vision` | model must have this tag |
| `<N>k` | `128k`, `200k` | minimum context window |
| `provider:<id>` | `provider:groq` | pin to a specific provider |

`kosha:fastest`, `kosha:reliable`, and `kosha:balanced` take the same filters and rank on observed latency and circuit-breaker state instead of price.

Every response carries `x-kosha-model`, `x-kosha-provider`, `x-kosha-requested`, `x-kosha-attempt-chain`, and `x-kosha-estimated-cost-usd`; non-streaming responses add `x-kosha-actual-cost-usd` when the upstream returned a usage block.

What the proxy can forward:

| Upstream wire format | Providers | Support |
|---|---|---|
| OpenAI-compatible | OpenAI, Ollama, OpenRouter, Vercel, Groq, Together, Fireworks, DeepInfra, … | passthrough, streaming included |
| Anthropic Messages | Anthropic | translated: streaming, tools, `image_url`, `response_format`, `reasoning_effort`; audio input and non-function tools fail over to an OpenAI-compatible route for the same model |
| Cloud SDKs | Google, Bedrock, Vertex | discovery only, not proxied yet |
| Non-chat / other wire | TypeSafe, Thinking Machines | discovery only — TypeSafe's System One endpoint is not a chat API, and Tinker's Anthropic-wire path differs from Anthropic's own |

Defaults that matter before you expose it: the server binds `127.0.0.1`. Pass `--host 0.0.0.0` (or `KOSHA_HOST`) to listen on a network interface, and set `KOSHA_PROXY_TOKEN` so `/proxy/*` and `POST /api/refresh` require `Authorization: Bearer <token>` or `x-kosha-token`. `KOSHA_MONTHLY_BUDGET_USD` caps spend per calendar month. Reference: [docs/api.md](docs/api.md#openai-compatible-proxy), [docs/operations.md](docs/operations.md).

### MCP server

`kosha-mcp` serves the registry over the Model Context Protocol on stdio, so an agent can call `kosha_query_models`, `kosha_cheapest_model`, `kosha_ranked_routes`, `kosha_model_detail`, `kosha_model_routes`, `kosha_resolve_alias`, `kosha_provider_health`, and `kosha_context_strategy` without an HTTP server.

```bash
claude mcp add kosha -- kosha-mcp
```

It is published to the [MCP registry](https://github.com/modelcontextprotocol/registry)
as `io.github.sriinnu/kosha-discovery`, so clients that read the registry can
install it without a manual command. The manifest is [`server.json`](server.json).

Every provider key is optional. With no credentials at all the server still
answers from the public models.dev and LiteLLM catalogs plus a curated offline
list, so it is useful on a fresh machine.

Tools and protocol details: [docs/mcp.md](docs/mcp.md).

## Supported providers

45 providers. Each has a descriptor in `src/provider-catalog.ts`; most OpenAI-compatible
ones are driven from `GENERIC_OPENAI_PROVIDERS` in `src/discovery/generic-openai.ts`
rather than a hand-written class.

| Provider | Discovery | Credential sources |
|----------|-----------|--------------------|
| Anthropic | `GET /v1/models` (context, output cap, capabilities read from the API) | `ANTHROPIC_API_KEY`, Claude CLI, Codex CLI |
| OpenAI | `GET /v1/models` | `OPENAI_API_KEY`, GitHub Copilot tokens |
| Google | `GET /v1beta/models` | `GOOGLE_API_KEY`, `GEMINI_API_KEY`, Gemini CLI, gcloud |
| AWS Bedrock | SDK → CLI → static list | `AWS_ACCESS_KEY_ID`, `~/.aws/credentials`, SSO, IAM |
| Vertex AI | API + gcloud | `GOOGLE_APPLICATION_CREDENTIALS`, ADC |
| Ollama, llama.cpp, LM Studio, vLLM | local HTTP API | none |
| OpenRouter | API | `OPENROUTER_API_KEY` (optional; unauthenticated is rate-limited) |
| Vercel AI Gateway | `GET /v1/models` | `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN` (discovery works without; execution needs one) |
| NVIDIA, Together, Fireworks, Groq, Cerebras, Cohere, DeepInfra, Perplexity | OpenAI-compatible API | `<PROVIDER>_API_KEY` |
| DeepSeek, Mistral, Moonshot (Kimi), GLM (Zhipu), Z.AI, MiniMax | OpenAI-compatible API | `<PROVIDER>_API_KEY` |
| xAI (Grok) | `GET /v1/models`; Grok Imagine split into image / video | `XAI_API_KEY` |
| TypeSafe (System One / Jev) | `GET /v1/models` — returns `judgment` models, not chat | `TYPESAFE_API_KEY`, `JEV_API_KEY` |
| Thinking Machines (Inkling) | Anthropic-wire endpoint, no model list — public catalog only | `TINKER_API_KEY` |
| Alibaba Model Studio (Qwen), Volcengine Ark (Doubao), Inception (Mercury), AI21 (Jamba), Upstage (Solar), StepFun | OpenAI-compatible API | `DASHSCOPE_API_KEY`, `ARK_API_KEY`, `INCEPTION_API_KEY`, `AI21_API_KEY`, `UPSTAGE_API_KEY`, `STEPFUN_API_KEY` |
| Baseten, Nebius Token Factory, Novita AI, SiliconFlow, Hugging Face, Ollama Cloud | OpenAI-compatible API | `<PROVIDER>_API_KEY`, `HF_TOKEN` |

### Regional pairs

Several providers run separate hosts for international and mainland-China
traffic, with separate keys and **separate price sheets** — Qwen 2.5 72B is
$1.40/M input internationally against $0.574/M in China. Merging them would make
a model's price depend on which host answered last, so each region is its own
provider:

| International | China | Differs in |
|---|---|---|
| `moonshot` (`api.moonshot.ai`) | `moonshot-cn` (`api.moonshot.cn`) | host, key |
| `minimax` (`api.minimax.io`) | `minimax-cn` (`api.minimaxi.com`) | host, key |
| `alibaba` (`dashscope-intl`) | `alibaba-cn` (`dashscope`) | host, key, pricing |
| `siliconflow` (`.com`) | `siliconflow-cn` (`.cn`) | host, key, pricing |
| `stepfun` (`api.stepfun.ai`) | `stepfun-cn` (`api.stepfun.com`) | host, key, pricing |
| `zai` (`api.z.ai`) | `glm` (`open.bigmodel.cn`) | host, key, pricing |

`kosha routes <model>` lists every region a model is served from, so you can
compare prices across them directly.

Without a key, providers fall back to the public models.dev + LiteLLM catalog, then to a curated static list, so `kosha list` works on a fresh machine. Exact env var names: [docs/credentials.md](docs/credentials.md).

### Non-chat modes

Most models are `chat`, but `mode` also covers `embedding`, `image`, `video`,
`audio`, `moderation`, `rerank`, and `judgment`. A `judgment` model — TypeSafe's
System One family — answers a question with a typed value (a choice and its
probability distribution, a probability, or a score on described levels) instead
of generating text. It carries no `chat` capability on purpose: routing a prompt
to one would be a category error.

```bash
kosha cheapest --role judgment    # rank judgment models by price
kosha model jev                   # mode: judgment, $0.042/M in, $0 out
```

## How it works

1. **Discovery** — one discoverer per provider runs concurrently (`Promise.allSettled`); each returns normalized `ModelCard`s. A failing provider is recorded in `discoveryErrors()` and doesn't block the others.
2. **Enrichment** — pricing, context window, and output cap are filled from models.dev and LiteLLM where the provider API doesn't publish them; `pricingSource` on each card says which.
3. **Resilience** — a per-provider circuit breaker with exponential cooldown, plus stale-cache fallback, so a provider outage degrades to cached data rather than an error.
4. **Cache and manifest** — results are cached under `~/.kosha/cache/` (24 h TTL) and exported as a versioned snapshot at `~/.kosha/registry.json` for other tools to read.
5. **Proxy** — resolves the requested model or `kosha:<strategy>[filters]` selector against the registry, ranks candidate routes, forwards with failover, and records estimated and reconciled cost in `~/.kosha/ledger-YYYY-MM.jsonl`.

Details: [docs/architecture.md](docs/architecture.md), [docs/resilience.md](docs/resilience.md).

## Development

```bash
pnpm install
pnpm run build        # compile to dist/
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # biome lint
pnpm test             # vitest run
pnpm run check        # lint + build + test
```

### Project layout

```
src/
  cli.ts                 # CLI entry point and arg parsing
  cli-commands.ts        # command implementations (+ cli-cmd-*.ts for the larger ones)
  registry.ts            # ModelRegistry public API
  registry-runtime.ts    # discovery orchestration, enrichment, cache, manifest export
  registry-query.ts      # model / role / capability queries
  registry-selection.ts  # cheapest candidates, binding hints
  registry-routing.ts    # cheapest / fastest / reliable / balanced ranking
  discovery/             # one discoverer per provider + static and public-seed catalogs
  enrichment/            # models.dev + LiteLLM pricing enrichment
  credentials/           # credential resolution (env, CLI files, ADC, OAuth)
  provider-catalog.ts    # provider descriptors: base URLs, transport, env var names
  aliases.ts             # built-in short names → canonical model IDs
  claude-generation.ts   # which Claude generation accepts which API parameters
  model-features.ts      # tool dialect / structured-output inference per model
  proxy.ts               # OpenAI-compatible proxy: routing, failover, ledger
  wire-anthropic.ts      # OpenAI ↔ Anthropic request / response / SSE translation
  cost.ts                # spend ledger, budget gates, usage reconciliation
  tally.ts               # zero-dependency token usage + USD tally (also exported as ./tally)
  server.ts              # Hono HTTP API + operator token gate
  mcp-server.ts          # MCP stdio server
  types.ts               # shared types
```

### Adding a provider

For an OpenAI-compatible provider — most of them — it is two table entries:

1. Add a descriptor to `PROVIDER_CATALOG` in `src/provider-catalog.ts` (id, base URL, transport, credential env vars).
2. Add a spec to `GENERIC_OPENAI_PROVIDERS` in `src/discovery/generic-openai.ts`. It registers its own discoverer, resolves credentials from the descriptor's `credentialEnvVars`, and falls back to the public catalog when there is no key.
3. Map the provider to its models.dev / LiteLLM slug in `src/discovery/modelsdev-seed.ts` and `litellm-seed.ts` so keyless discovery works. **Check the slug** — GLM is published as `zhipuai`, and a missing mapping means no keyless models at all.
4. Add a case to `test/discovery/generic-openai.test.ts` and document the env vars in `docs/credentials.md`.

Write a discoverer class only when classification genuinely needs code — per-route pricing (OpenRouter), a non-OpenAI response envelope (TypeSafe), or origin remapping (Vercel):

1. Create `src/discovery/<provider>.ts` extending `BaseDiscoverer` or `OpenAICompatibleDiscoverer`; `fetchJSON` and `makeCard` are provided.
2. Export it from `src/discovery/index.ts` and add a factory entry to `DISCOVERER_REGISTRY`.
3. Add a resolver branch in `src/credentials/resolver.ts` only for a bespoke search order (CLI files, OAuth, ADC, SSO). A plain API key in env vars needs no branch — the descriptor covers it.
4. Add `test/discovery/<provider>.test.ts` (mock `fetch`; see `typesafe.test.ts`).

## Docs

| | |
|---|---|
| [Credentials](docs/credentials.md) | Env vars, CLI tools, and config files for every provider |
| [CLI](docs/cli.md) | Commands, flags, examples |
| [HTTP API](docs/api.md) | Endpoints, parameters, response schemas |
| [MCP server](docs/mcp.md) | Tools, protocol negotiation, client setup |
| [Configuration](docs/configuration.md) | Aliases, routing, enrichment, programmatic config |
| [Architecture](docs/architecture.md) | Discovery flow, module map, adding providers |
| [Resilience](docs/resilience.md) | Circuit breakers, stale cache, health |
| [Operations](docs/operations.md) | Deployment sizing, metrics, spend ledger, recovery recipes |
| [Security](docs/security.md) | Threat catalogue, runtime scanning, pre-commit hook |
| [Discovery Plane v1](docs/discovery-plane-v1.md) | Stable daemon contract (deltas, SSE watch, binding hints) |

## Release

1. Bump `version` in `package.json` and date the `[Unreleased]` section in `CHANGELOG.md`; merge that as a PR.
2. Tag and push:

```bash
git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
gh workflow run release-npm.yml -f tag=vX.Y.Z
```

The workflow checks that the tag matches `package.json`, runs lint / build / test, publishes to npm with provenance, and creates the GitHub Release. Publishing authenticates through npm trusted publishing (OIDC) when a trusted publisher is configured for this repo and workflow on npmjs.com, or through an `NPM_TOKEN` repository secret.

## License

MIT
