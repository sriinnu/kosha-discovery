# kosha-discovery — Skill Reference

Reference for agents and scripts that use `@sriinnu/kosha-discovery` (कोश, "treasury"). It discovers the model lists of 25 providers and local runtimes, resolves credentials, fills in pricing and limits, and exposes the result as a library, CLI, HTTP API, OpenAI-compatible proxy, and MCP server.

Use it to: list available models, pick the cheapest model for a task, rank routes by latency or reliability, check which providers are authenticated, resolve aliases, or forward a chat request through a provider you hold a key for while tracking spend.

Every fact below is checked against `src/`; where behaviour depends on configuration, the env var is named.

---

## Providers

| Provider | Discovery endpoint | Credential sources (checked in order) |
|---|---|---|
| Anthropic | `GET https://api.anthropic.com/v1/models` — `max_input_tokens`, `max_tokens`, `capabilities` are read from the response | `ANTHROPIC_API_KEY`; `~/.claude.json`, `~/.config/claude/settings.json`, `~/.claude/credentials.json` (Claude CLI); `~/.codex/auth.json` (Codex CLI) |
| OpenAI | `GET https://api.openai.com/v1/models` | `OPENAI_API_KEY`; `~/.config/github-copilot/hosts.json` (`%LOCALAPPDATA%` on Windows) |
| Google (Gemini) | `GET https://generativelanguage.googleapis.com/v1beta/models` | `GOOGLE_API_KEY` or `GEMINI_API_KEY`; `~/.gemini/oauth_creds.json`; gcloud ADC |
| AWS Bedrock | `@aws-sdk/client-bedrock` if installed → `aws bedrock list-foundation-models` → static list | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`; `~/.aws/credentials`; `~/.aws/config` (SSO, `role_arn`); `AWS_PROFILE`. Region: `AWS_DEFAULT_REGION` → `AWS_REGION` → `~/.aws/config` → `us-east-1`. IDs look like `anthropic.claude-opus-4-8-v1:0` |
| Vertex AI | API + `gcloud auth print-access-token` (5 s timeout) | `GOOGLE_APPLICATION_CREDENTIALS`, ADC; project from `GOOGLE_CLOUD_PROJECT` → `GCLOUD_PROJECT` → `gcloud config get-value project` |
| OpenRouter | `GET https://openrouter.ai/api/v1/models` | `OPENROUTER_API_KEY` (optional; unauthenticated works, rate-limited). `originProvider` from the ID prefix (`openai/gpt-4o` → `openai`) |
| Vercel AI Gateway | `GET /v1/models` | `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`; discovery works without, the proxy needs one |
| Ollama / llama.cpp / LM Studio / vLLM | local HTTP (`localhost:11434/api/tags` for Ollama, etc.) | none; base URL overridable in config |
| NVIDIA, Together, Fireworks, Groq, Cerebras, Cohere, DeepInfra, Perplexity, DeepSeek, Mistral, Moonshot, GLM, Z.AI, MiniMax | provider `/models` endpoint (OpenAI-compatible) | `NVIDIA_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `CO_API_KEY`, `DEEPINFRA_API_KEY`, `PERPLEXITY_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY` / `KIMI_API_KEY`, `GLM_API_KEY` / `ZHIPUAI_API_KEY`, `ZAI_API_KEY`, `MINIMAX_API_KEY` |

Without a key, direct providers fall back to the public models.dev + LiteLLM catalog, then to a curated static list (`src/discovery/static-direct.ts`). `provider.authenticated` and `provider.credentialSource` (`env` / `cli` / `config` / `oauth` / `none`) tell you which path ran.

---

## Library

```typescript
import { createKosha, ModelRegistry } from "@sriinnu/kosha-discovery";

// Runs discovery for all providers; loads ~/.kosharc.json then ./kosha.config.json.
const kosha = await createKosha();

// Read
kosha.models()                                     // ModelCard[]
kosha.models({ provider: "anthropic" })            // serving-layer provider
kosha.models({ originProvider: "anthropic" })      // model creator (matches bedrock/openrouter routes too)
kosha.models({ mode: "embedding" })                // "chat" | "embedding" | "image" | "video" | "audio" | "moderation" | "rerank"
kosha.models({ capability: "vision" })
kosha.model("sonnet")                              // ModelCard | undefined; alias or ID; tolerant of "anthropic/" prefix and 4.6 vs 4-6
kosha.resolve("opus")                              // "claude-opus-5" — alias → canonical ID (input returned unchanged if unknown)
kosha.modelRoutes("claude-opus-5")                 // ModelCard[] — every serving route
kosha.modelRouteInfo("claude-opus-5")              // routes with isDirect / isPreferred / baseUrl
kosha.cheapestModels({ role: "embeddings", limit: 3 })   // { matches, missingCredentials, priceMetric, … }
kosha.rankedRoutes({ mode: "chat", capability: "tool_use" }, "reliable")  // "cheapest" | "fastest" | "reliable" | "balanced"
kosha.providerRouteHealth("groq")                  // breaker state, p95 latency, reliability score
kosha.provider("anthropic")                        // ProviderInfo | undefined
kosha.providers_list()                             // ProviderInfo[]
kosha.providerRoles({ role: "embeddings" })        // provider → model → roles matrix
kosha.capabilities({ provider: "openai" })         // capability summaries
kosha.missingCredentialPrompts(["bedrock"])        // [{ providerId, message, envVars }]
kosha.discoveryErrors()                            // [{ providerId, providerName, error, timestamp }]

// Write
kosha.alias("fast", "claude-haiku-4-5")            // custom alias (wins over built-ins)
await kosha.refresh()                              // re-discover everything, bypassing the cache
await kosha.refresh("anthropic")                   // one provider

// Config / persistence
const config = await ModelRegistry.loadConfigFile({ cacheTtlMs: 3_600_000 });
const registry = new ModelRegistry(config);
const json = kosha.toJSON();                       // serializable state
const restored = ModelRegistry.fromJSON(json);     // no network
```

Other exports worth knowing: `DEFAULT_ALIASES`, `normalizeModelId`, `extractOriginProvider`, `inferToolDialect`, `inferStructuredOutputModes`, `parseClaudeGeneration` and the `claude*` predicates, `estimateRequestCost`, `actualCostFromUsage`, `readSpendForMonth`, `translateOpenAIToAnthropic`, `translateAnthropicStreamToOpenAI`. `@sriinnu/kosha-discovery/tally` is a zero-dependency token-usage + USD tally for browser and edge code.

---

## CLI

```bash
kosha discover                          # query every provider; writes ~/.kosha/cache + ~/.kosha/registry.json
kosha list [--provider x] [--origin x] [--mode x] [--capability x]
kosha search <query>                    # case-insensitive substring match on ID and name
kosha model <id|alias>                  # one card; aliases: info, show
kosha routes <id|alias>                 # every serving route with pricing
kosha resolve <alias>
kosha providers                         # auth state + credential source per provider
kosha roles [--role x]                  # provider → model → roles
kosha capabilities                      # alias: caps
kosha capable <capability> [--provider x] [--limit n]
kosha cheapest [--role x] [--capability x] [--provider x] [--limit n] [--price-metric input|output|blended] [--include-unpriced]
kosha latest [--provider x]             # force-fetch the newest provider details and print them
kosha refresh [--provider x]            # alias: update
kosha enrich                            # re-run pricing enrichment on the cache
kosha doctor [--ci]                     # deprecations + breaker state; --ci exits non-zero on findings
kosha spend [--since iso] [--until iso] [--tenant x] [--ledger path]
kosha serve [--port 3000] [--host 127.0.0.1]
```

`--json` works on every command. Results come from `~/.kosha/cache/` (24 h TTL) unless the command says otherwise.

---

## HTTP API

Start with `kosha serve --port 3000` or `PORT=3000 node dist/server.js`. Binds `127.0.0.1` unless `--host` / `KOSHA_HOST` is set.

```
GET  /api/models?provider=&originProvider=&mode=&capability=   → { models, count }   (invalid mode → 400)
GET  /api/models/cheapest?role=&capability=&provider=&limit=&priceMetric=&includeUnpriced=
GET  /api/models/:idOrAlias                → card + baseUrl + version + isDirectProvider
GET  /api/models/:idOrAlias/routes         → { model, preferredProvider, routes }
GET  /api/roles?role=                      → { providers, count, modelCount, missingCredentials }
GET  /api/capabilities?provider=           → { capabilities, count, missingCredentials }
GET  /api/providers                        → summaries (no model arrays)
GET  /api/providers/:id                    → provider with models
GET  /api/resolve/:alias                   → { alias, resolved, isAlias }
GET  /api/discovery-errors                 → { errors, count, hasErrors }
GET  /api/discovery                        → stable v1 snapshot (docs/discovery-plane-v1.md)
GET  /api/discovery/delta?sinceCursor=     → changes since a cursor
GET  /api/discovery/watch                  → SSE stream of changes
GET  /api/discovery/cheapest, /binding     → v1-contract queries
GET  /health                               → { status: "ok" | "degraded", models, providers, uptime }
GET  /metrics                              → Prometheus text; KOSHA_METRICS_TOKEN gates it when set
POST /api/refresh  { "provider"?: "x" }    → re-discover; gated by KOSHA_PROXY_TOKEN when set
```

### Proxy

```
GET  /proxy/v1/models                      → OpenAI-shaped list of forwardable chat models
POST /proxy/v1/chat/completions            → OpenAI chat-completions body
```

`model` is a canonical ID, an alias, or a selector: `kosha:cheapest`, `kosha:fastest`, `kosha:reliable`, `kosha:balanced`, optionally with `[filters]` — a capability tag, `<N>k` minimum context, `provider:<id>` — e.g. `kosha:cheapest[tool_use,128k,provider:groq]`.

- Candidates are ranked and tried in order (max 3 fetches); 5xx / network errors fail over, 4xx is returned as-is. `x-kosha-attempt-chain` lists `provider:status` per attempt.
- Anthropic routes are translated to and from `/v1/messages`: streaming, tools, `image_url`, `response_format` (json_schema on Claude 4.5+), `reasoning_effort`. Sampling params are dropped on generations that reject them; every lossy mapping is listed in `x-kosha-wire-notes`. Audio input and non-function tools fail over to an OpenAI-compatible route for the same model, or `422` if none is credentialed.
- Google, Bedrock, Vertex are not proxied (cloud SDK wire formats).
- Auth: with `KOSHA_PROXY_TOKEN` set, send `Authorization: Bearer <token>` or `x-kosha-token: <token>`. Tenant tag for ledger bucketing: `x-kosha-tenant: <name>` (not authentication).
- Cost: `x-kosha-estimated-cost-usd` on every response; `x-kosha-actual-cost-usd` + `x-kosha-usage-source` on non-streaming responses with a usage block. Rows land in `~/.kosha/ledger-YYYY-MM.jsonl`; streaming responses write the estimate first and an `adjustment` row when usage arrives. `KOSHA_MONTHLY_BUDGET_USD` (global) and `KOSHA_TENANT_BUDGET_USD` (per tag) return `429` when exceeded; an unreadable ledger returns `503` rather than assuming zero spend.

Full reference: `docs/api.md`.

---

## MCP server

`kosha-mcp` (or `node dist/mcp-server.js`) speaks MCP over stdio (`2025-06-18`, `2025-03-26`, `2024-11-05`). Register with `claude mcp add kosha -- kosha-mcp` or the equivalent `mcpServers` entry.

| Tool | Arguments |
|---|---|
| `kosha_query_models` | `provider`, `mode`, `capability`, `limit` |
| `kosha_cheapest_model` | `capability`, `min_context_k`, `provider`, `limit` |
| `kosha_ranked_routes` | `strategy` (required), `capability`, `min_context_k`, `provider`, `limit` |
| `kosha_model_detail` | `model` |
| `kosha_model_routes` | `model` |
| `kosha_resolve_alias` | `alias` |
| `kosha_provider_health` | `provider` |
| `kosha_context_strategy` | `model`, `current_tokens`, `expected_output_tokens`, `expected_remaining_turns` |

Tool execution failures come back as `isError: true` results; unknown tools or bad arguments are JSON-RPC `-32602`. Details: `docs/mcp.md`.

---

## Key types

```typescript
ModelCard {
  id: string;                    // "claude-sonnet-5"
  name: string;                  // "Claude Sonnet 5"
  provider: string;              // serving layer: "anthropic", "openrouter", "bedrock", …
  originProvider?: string;       // model creator; differs from provider on proxied routes
  mode: ModelMode;               // "chat" | "embedding" | "image" | "video" | "audio" | "moderation" | "rerank"
  capabilities: string[];        // ["chat", "vision", "function_calling", "reasoning", "structured_output", "prompt_caching", "code", "nlu"]
  contextWindow: number;         // 1000000
  maxOutputTokens: number;       // 128000
  pricing?: ModelPricing;        // { inputPerMillion, outputPerMillion, cacheReadPerMillion?, cacheWritePerMillion?, batchInputPerMillion?, longContextInputPerMillion?, … } — USD per 1M tokens
  pricingSource?: "provider-live" | "litellm" | "static-seed" | "missing";
  aliases: string[];             // ["sonnet", "sonnet-5"]
  status?: "active" | "preview" | "deprecated" | "retired";
  deprecationDate?: string; replacedBy?: string;
  source: "api" | "litellm" | "local" | "manual";
  toolDialect?: ToolDialect;                     // "anthropic-tools" | "openai-tools" | "openai-responses" | "gemini-functions" | …
  structuredOutputModes?: StructuredOutputMode[]; // ["json-schema", "tool-choice", "xml"] etc.
  supportsParallelToolCalls?: boolean;
  tokenizerFamily?: string;      // "claude" | "o200k_base" | "gemini" | …
  region?: string;               // Bedrock
  projectId?: string;            // Vertex
  localRuntime?: LocalRuntimeMetadata;  // Ollama / llama.cpp / LM Studio / vLLM details
}

ProviderInfo {
  id: string; name: string; baseUrl: string;
  authenticated: boolean;
  credentialSource?: "env" | "cli" | "config" | "oauth" | "none";
  models: ModelCard[];
  lastRefreshed: number;         // epoch ms
}

CheapestModelResult {
  matches: CheapestModelMatch[]; // [{ model, score, priceMetric }] ascending
  candidates: number; pricedCandidates: number; skippedNoPricing: number;
  priceMetric: "input" | "output" | "blended";
  missingCredentials: ProviderCredentialPrompt[];  // [{ providerId, message, envVars }]
}

LedgerEntry {                    // one JSON object per line in ~/.kosha/ledger-YYYY-MM.jsonl
  ts: number; provider: string; modelId: string; requested: string; tenant: string | null;
  estimatedUsd: number; estimatedInputTokens: number; estimatedOutputTokens: number; upstreamStatus: number;
  actualUsd?: number; actualInputTokens?: number; actualOutputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  usageSource?: "upstream" | "estimate";
  kind?: "request" | "adjustment"; requestId?: string; adjustmentUsd?: number;
}
```

---

## Files and environment

| Path / variable | Purpose |
|---|---|
| `~/.kosharc.json`, `./kosha.config.json` | Config: per-provider `apiKey` / `baseUrl` / `enabled`, `aliases`, `cacheTtlMs` |
| `~/.kosha/cache/` | Discovery cache, one JSON per provider, 24 h TTL |
| `~/.kosha/registry.json` | Versioned manifest written after every discovery (`DISCOVERY_SCHEMA_VERSION`) |
| `~/.kosha/ledger-YYYY-MM.jsonl` | Proxy spend ledger, monthly partitions (`KOSHA_LEDGER_RETENTION_MONTHS`, default 12) |
| `KOSHA_HOST`, `PORT` | Bind address (default `127.0.0.1`) and port (default 3000) |
| `KOSHA_PROXY_TOKEN` | Operator token for `/proxy/*` and `POST /api/refresh` |
| `KOSHA_METRICS_TOKEN` | Bearer token for `/metrics` |
| `KOSHA_MONTHLY_BUDGET_USD`, `KOSHA_TENANT_BUDGET_USD` | Spend caps enforced by the proxy |

---

## Role and capability aliases

Normalized in every query (`kosha.normalizeRoleToken()`):

| Input | Normalizes to |
|---|---|
| `embeddings`, `vector`, `vectors` | `embedding` |
| `images`, `imagegen`, `image_generation` | `image_generation` |
| `stt`, `transcription` | `speech_to_text` |
| `tts` | `text_to_speech` |
| `speech` | `audio` |
| `tools`, `tool_use`, `functions`, `functioncalling` | `function_calling` |
| `prompt_cache` | `prompt_caching` |
| `completion`, `completions` | `chat` |

Built-in model aliases (`src/aliases.ts`): a bare family name tracks the newest GA model — `fable` → `claude-fable-5-1`, `opus` → `claude-opus-5`, `sonnet` → `claude-sonnet-5`, `haiku` → `claude-haiku-4-5`, `gpt5` → `gpt-5`, `gemini-pro` → `gemini-2.5-pro`; suffixed forms (`opus-4.8`, `sonnet-4`) pin a generation. Full table: `docs/configuration.md`.

---

## Common tasks

```typescript
// Which models can do X?
kosha.models({ capability: "vision" });

// Cheapest embedding model I can actually call
const { matches, missingCredentials } = kosha.cheapestModels({ role: "embeddings", limit: 1 });
// matches[0].model.provider is one you hold credentials for; missingCredentials lists the rest

// Most reliable tool-capable chat route right now (breaker-open providers sort last)
const [best] = kosha.rankedRoutes({ mode: "chat", capability: "tool_use", limit: 5 }, "reliable");

// Is provider X usable?
const bedrock = kosha.provider("bedrock");
if (!bedrock?.authenticated) console.log(kosha.missingCredentialPrompts(["bedrock"])[0].envVars);

// Cheapest way to reach a specific model
kosha.modelRouteInfo("claude-opus-5").sort((a, b) => (a.model.pricing?.inputPerMillion ?? Infinity) - (b.model.pricing?.inputPerMillion ?? Infinity))[0];

// Did discovery fail anywhere?
for (const e of kosha.discoveryErrors()) console.warn(`${e.providerName}: ${e.error}`);
```
