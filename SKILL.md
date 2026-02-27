# kosha-discovery — Skill Reference

## What This Is

Kosha-discovery (कोश) is an AI Model & Provider Discovery Registry. It discovers models across 7 providers, resolves credentials automatically, enriches with pricing data, and exposes everything via library, CLI, or HTTP API.

Use this skill when you need to: find available models, pick the cheapest model for a task, check which providers are authenticated, resolve model aliases, or route between providers.

---

## Providers & Credential Locations

### Anthropic
- **Discovery**: `GET https://api.anthropic.com/v1/models`
- **Env var**: `ANTHROPIC_API_KEY`
- **CLI files** (auto-detected):
  - `~/.claude.json` — Claude CLI stored token
  - `~/.config/claude/settings.json` — Claude CLI settings
  - `~/.claude/credentials.json` — Claude CLI OAuth
  - `~/.codex/auth.json` — Codex CLI (stores Anthropic keys)

### OpenAI
- **Discovery**: `GET https://api.openai.com/v1/models`
- **Env var**: `OPENAI_API_KEY`
- **CLI files** (auto-detected):
  - `~/.config/github-copilot/hosts.json` — GitHub Copilot token (Linux/macOS)
  - `%LOCALAPPDATA%/github-copilot/hosts.json` — Copilot token (Windows)

### Google (Gemini)
- **Discovery**: `GET https://generativelanguage.googleapis.com/v1beta/models`
- **Env vars**: `GOOGLE_API_KEY` or `GEMINI_API_KEY`
- **CLI files** (auto-detected):
  - `~/.gemini/oauth_creds.json` — Gemini CLI OAuth
  - `~/.config/gcloud/application_default_credentials.json` — gcloud ADC

### AWS Bedrock
- **Discovery** (3-layer fallback):
  1. `@aws-sdk/client-bedrock` SDK (if installed) — `ListFoundationModelsCommand`
  2. `aws bedrock list-foundation-models --output json` CLI
  3. Static fallback (7 well-known models: Claude, Titan, Llama, Mistral)
- **Env vars**: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
- **Region**: `AWS_DEFAULT_REGION` → `AWS_REGION` → `~/.aws/config [default] region` → `us-east-1`
- **CLI files** (auto-detected):
  - `~/.aws/credentials` — `[default]` profile `aws_access_key_id`
  - `~/.aws/config` — SSO (`sso_start_url`), IAM role (`role_arn`)
- **Named profile**: `AWS_PROFILE` env var
- **Model ID format**: `{vendor}.{model-name}-v{n}:{variant}` (e.g. `anthropic.claude-opus-4-6-v1:0`)

### Vertex AI (Google Cloud)
- **Discovery**: Vertex AI API + gcloud
- **Env vars**: `GOOGLE_APPLICATION_CREDENTIALS` (path to service account JSON), `GOOGLE_CLOUD_PROJECT`
- **CLI files** (auto-detected):
  - `~/.config/gcloud/application_default_credentials.json` — gcloud ADC
- **Subprocess**: `gcloud auth print-access-token` (5s timeout)
- **Project resolution**: `GOOGLE_CLOUD_PROJECT` → `GCLOUD_PROJECT` → `gcloud config get-value project`

### OpenRouter
- **Discovery**: `GET https://openrouter.ai/api/v1/models`
- **Env var**: `OPENROUTER_API_KEY` (optional — works without auth, rate-limited)
- **Origin mapping**: extracts `originProvider` from model ID prefix (e.g. `openai/gpt-4o` → `openai`)

### Ollama (Local)
- **Discovery**: `GET http://localhost:11434/api/tags` + `GET /api/ps`
- **No credentials needed** — just needs Ollama running locally
- **Running models**: detected via `/api/ps` endpoint

---

## Data Access Patterns

### Library (TypeScript/JavaScript)

```typescript
import { createKosha, ModelRegistry } from "kosha-discovery";

// Auto-discovers all providers, loads config from ~/.kosharc.json
const kosha = await createKosha();

// --- READ operations ---
kosha.models()                                    // All models
kosha.models({ provider: "anthropic" })            // Filter by provider
kosha.models({ mode: "embedding" })                // Filter by mode
kosha.models({ capability: "vision" })             // Filter by capability
kosha.models({ originProvider: "openai" })         // Filter by model creator
kosha.model("sonnet")                              // Single model by alias/ID
kosha.provider("anthropic")                        // Provider info
kosha.providers_list()                             // All providers
kosha.providerRoles({ role: "embeddings" })        // Role matrix
kosha.cheapestModels({ role: "embeddings" })       // Cheapest ranked
kosha.capabilities()                               // Capability aggregation
kosha.capabilities({ provider: "openai" })         // Per-provider capabilities
kosha.resolve("sonnet")                            // Alias → canonical ID
kosha.discoveryErrors()                            // Errors from last discovery
kosha.missingCredentialPrompts()                   // Which providers need keys
kosha.normalizeRoleToken("tools")                  // → "function_calling"
kosha.modelSupportsRole(model, "vision")           // Capability check
kosha.modelRoles(model)                            // All roles for a model
kosha.modelRoutes("claude-opus-4-6")               // Cross-provider routes
kosha.modelRouteInfo("claude-opus-4-6")            // Routes with preferred/direct flags

// --- WRITE operations ---
kosha.alias("fast", "claude-haiku-4-5-20251001")   // Add custom alias
await kosha.refresh()                               // Re-discover all
await kosha.refresh("anthropic")                    // Re-discover one provider

// --- CONFIG ---
// Load from file: ~/.kosharc.json (global) + kosha.config.json (project)
const config = await ModelRegistry.loadConfigFile({ cacheTtlMs: 3600000 });
const registry = new ModelRegistry(config);

// Serialization
const json = kosha.toJSON();                        // Serialize state
const restored = ModelRegistry.fromJSON(json);       // Restore from JSON
```

### CLI

```bash
kosha discover                              # Full discovery
kosha list                                  # All models
kosha list --provider anthropic             # Filter by provider
kosha list --mode embedding                 # Filter by mode
kosha list --capability vision              # Filter by capability
kosha list --json                           # JSON output
kosha search gemini                         # Fuzzy search
kosha model sonnet                          # Single model detail
kosha providers                             # Provider status + credential info
kosha roles                                 # Full role matrix
kosha roles --role embeddings               # Filter by role
kosha cheapest --role embeddings            # Cheapest for task
kosha cheapest --role image --limit 3       # Top 3 cheapest image models
kosha capabilities                          # All capabilities overview
kosha caps                                  # Alias for capabilities
kosha capable vision                        # Models with a capability
kosha capable embeddings --provider openai  # Scoped capability query
kosha resolve haiku                         # Alias resolution
kosha refresh                               # Force re-discovery
kosha serve --port 3000                     # Start HTTP API
```

### HTTP API

Start: `kosha serve --port 3000` or `PORT=3000 node dist/server.js`

```
READ endpoints:
  GET /api/models                          → { models, count }
  GET /api/models?provider=anthropic       → filtered models
  GET /api/models?mode=embedding           → by mode
  GET /api/models?capability=vision        → by capability
  GET /api/models?originProvider=openai    → by model creator
  GET /api/models/cheapest?role=embeddings → { matches, cheapest, missingCredentials }
  GET /api/models/:idOrAlias               → single model + baseUrl + version
  GET /api/models/:idOrAlias/routes        → cross-provider routes with preferred flags
  GET /api/roles                           → provider → model → roles matrix
  GET /api/roles?role=embeddings           → filtered role matrix
  GET /api/capabilities                    → { capabilities, count, missingCredentials }
  GET /api/capabilities?provider=openai    → per-provider capabilities
  GET /api/providers                       → all providers (summary, no model arrays)
  GET /api/providers/:id                   → single provider with full model list
  GET /api/resolve/:alias                  → { alias, resolved, isAlias }
  GET /api/discovery-errors                → { errors, count, hasErrors }
  GET /health                              → { status, models, providers, uptime }

WRITE endpoints:
  POST /api/refresh                        → re-discover all providers
  POST /api/refresh { "provider": "x" }    → re-discover one provider
```

---

## Key Types

```typescript
ModelCard {
  id: string;                    // "claude-sonnet-4-20250514"
  name: string;                  // "Claude Sonnet 4"
  provider: string;              // "anthropic" (serving layer)
  originProvider?: string;       // "anthropic" (model creator — differs for bedrock/openrouter)
  mode: ModelMode;               // "chat" | "embedding" | "image" | "audio" | "moderation"
  capabilities: string[];        // ["chat", "vision", "function_calling", "code"]
  contextWindow: number;         // 200000
  maxOutputTokens: number;       // 16384
  pricing?: ModelPricing;        // { inputPerMillion: 3, outputPerMillion: 15 }
  aliases: string[];             // ["sonnet", "sonnet-4"]
  source: string;                // "api" | "litellm" | "local" | "manual"
  region?: string;               // "us-east-1" (Bedrock)
  projectId?: string;            // "my-project" (Vertex)
}

ProviderInfo {
  id: string;                    // "anthropic"
  name: string;                  // "Anthropic"
  baseUrl: string;               // "https://api.anthropic.com"
  authenticated: boolean;        // true if credential found
  credentialSource?: string;     // "env" | "cli" | "config" | "oauth" | "none"
  models: ModelCard[];
  lastRefreshed: number;         // Unix timestamp ms
}

DiscoveryError {
  providerId: string;            // "bedrock"
  providerName: string;          // "AWS Bedrock"
  error: string;                 // Error message
  timestamp: number;             // Unix timestamp ms
}

CheapestModelResult {
  matches: CheapestModelMatch[]; // Ranked by ascending score
  cheapest: CheapestModelMatch;  // First match (convenience)
  candidates: number;            // Total models matching filters
  pricedCandidates: number;      // Models with usable pricing
  skippedNoPricing: number;      // Excluded due to missing pricing
  priceMetric: string;           // "input" | "output" | "blended"
  missingCredentials: [];        // Providers needing API keys
}
```

---

## File Locations

| File | Purpose |
|------|---------|
| `~/.kosharc.json` | Global config (providers, aliases, cache settings) |
| `kosha.config.json` | Project-level config (overrides global) |
| `~/.kosha/cache/` | Cached discovery results (JSON files, 24h TTL) |
| `~/.aws/credentials` | AWS credential file (read by Bedrock discoverer) |
| `~/.aws/config` | AWS config (region, SSO, IAM roles) |
| `~/.config/gcloud/application_default_credentials.json` | Google ADC |
| `~/.claude.json` | Claude CLI token |
| `~/.config/github-copilot/hosts.json` | Copilot OAuth token |
| `~/.gemini/oauth_creds.json` | Gemini CLI OAuth |
| `~/.codex/auth.json` | Codex CLI stored keys |

---

## Role/Capability Aliases

These aliases are normalized automatically in queries:

| Input | Normalizes To |
|-------|--------------|
| `embeddings`, `vector`, `vectors` | `embedding` |
| `images`, `imagegen`, `image_generation` | `image_generation` |
| `stt`, `transcription` | `speech_to_text` |
| `tts` | `text_to_speech` |
| `speech` | `audio` |
| `tools`, `tool_use`, `functions`, `functioncalling` | `function_calling` |
| `prompt_cache` | `prompt_caching` |
| `completion`, `completions` | `chat` |

---

## Common Workflows

### "What models can do X?"
```typescript
const caps = kosha.capabilities();
const visionModels = kosha.models({ capability: "vision" });
```

### "Cheapest model for embeddings?"
```typescript
const result = kosha.cheapestModels({ role: "embeddings", limit: 1 });
const best = result.matches[0]; // { model, score, priceMetric }
```

### "Is the user authenticated with provider X?"
```typescript
const provider = kosha.provider("bedrock");
if (!provider?.authenticated) {
  const prompts = kosha.missingCredentialPrompts(["bedrock"]);
  // prompts[0].message → "Set AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY to enable..."
  // prompts[0].envVars → ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
}
```

### "Route this model through the cheapest provider"
```typescript
const routes = kosha.modelRouteInfo("claude-opus-4-6");
const preferred = routes.find(r => r.isPreferred);
// preferred.provider → "anthropic" (direct), preferred.baseUrl → "https://api.anthropic.com"
```

### "Did discovery fail for any provider?"
```typescript
const errors = kosha.discoveryErrors();
for (const err of errors) {
  console.warn(`${err.providerName} failed: ${err.error}`);
}
```
