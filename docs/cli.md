# CLI Reference

```
USAGE
  kosha <command> [options]

COMMANDS
  discover                      Discover all providers and models
  list                          List all known models
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by origin/creator provider (e.g. anthropic)
    --mode <mode>                 Filter by mode (chat, embedding, image, audio)
    --capability <cap>            Filter by capability (vision, function_calling, etc.)
  search <query>                Search models by name/ID (fuzzy match)
    --origin <name>               Restrict search to a specific origin provider
  model <id|alias>              Show detailed info for one model
  roles                         Show provider -> model -> roles matrix
    --role <role>                 Filter by task role (e.g. embeddings, image, tool_use)
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by model creator provider
    --mode <mode>                 Filter by mode (chat, embedding, image, audio, moderation)
    --capability <cap>            Filter by capability tag
  capabilities (caps)           Show all capabilities across the ecosystem
    --provider <name>             Scope to one provider
  capable <capability>          List models with a given capability
    --provider <name>             Filter by serving-layer provider
    --origin <name>               Filter by origin/creator provider
    --mode <mode>                 Filter by mode (chat, embedding, image, audio)
    --limit <n>                   Maximum models to show
  cheapest                      Find cheapest eligible models
    --role <role>                 Task role, e.g. embeddings or image
    --capability <cap>            Capability filter (vision, embedding, function_calling)
    --mode <mode>                 Mode filter
    --limit <n>                   Maximum matches to return (default 5)
    --price-metric <metric>       input | output | blended
    --input-weight <n>            Weight for blended metric input price
    --output-weight <n>           Weight for blended metric output price
    --include-unpriced            Include unpriced models after ranked matches
  routes <id|alias>             Show all provider routes for a model
  providers                     List all providers and their status
  resolve <alias>               Resolve an alias to canonical model ID
  refresh (update)              Force re-discover all providers (bypass cache)
  serve [--port 3000]           Start HTTP API server

OPTIONS
  --json                          Output as JSON (works with any command)
  --help                          Show this help message
  --version                       Show version
```

## Caching & Manifest

Every discovery path — `kosha discover`, `kosha update`, `kosha refresh`,
`kosha serve`, and any command that triggers a cold-start discovery
(`list`, `search`, `model`, `cheapest`, etc.) — writes two artifacts:

| Path | Purpose | Format |
|------|---------|--------|
| `~/.kosha/cache/*.json` | Internal TTL cache (24h default) | Cache envelope `{ data, timestamp }` — **do not parse directly** |
| `~/.kosha/registry.json` | Stable, third-party-readable manifest | v1 `DiscoverySnapshot` — safe for any consumer |

### How it behaves

- **Cold start** — `kosha` hits every provider API, runs LiteLLM enrichment,
  writes both the cache and the manifest, and prints
  `Discovered N models from M providers.`
- **Warm start (within TTL)** — `kosha` hydrates from `~/.kosha/cache` in
  milliseconds, rewrites the manifest to match, and prints
  `Loaded N models from cache (Xh ago). Run "kosha update" to refresh.`
- **Force refresh** — `kosha update` (alias for `kosha refresh`) invalidates
  the cache, re-runs discovery, and rewrites both artifacts.

### Consuming the manifest

The manifest follows the [Discovery Plane v1](./discovery-plane-v1.md) schema,
so it is stable across kosha versions. Any language or tool that reads JSON
can use it directly:

```bash
# jq — list free models
jq '.models[] | select(.pricing.inputPerMillion == 0) | .modelId' ~/.kosha/registry.json

# jq — group model counts by provider
jq '.providers | map({providerId, modelCount}) | sort_by(-.modelCount)' ~/.kosha/registry.json
```

```python
import json, pathlib
data = json.loads(pathlib.Path("~/.kosha/registry.json").expanduser().read_text())
chat = [m for m in data["models"] if m["mode"] == "chat"]
print(f"{len(chat)} chat models across {len(data['providers'])} providers")
```

```go
// Go — read the manifest with encoding/json
f, _ := os.ReadFile(os.Getenv("HOME") + "/.kosha/registry.json")
var snap struct {
    SchemaVersion int              `json:"schemaVersion"`
    Providers     []map[string]any `json:"providers"`
    Models        []map[string]any `json:"models"`
}
json.Unmarshal(f, &snap)
```

### Configuring the TTL

Set `cacheTtlMs` in `~/.kosharc.json` or `./kosha.config.json`:

```json
{ "cacheTtlMs": 3600000 }
```

See [configuration.md](./configuration.md) for the full config surface.

## Examples

### `kosha list`

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
234 models from 16 providers
```

### `kosha model sonnet`

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

### `kosha providers`

```
Provider     Status          Models  Credential Source
──────────── ─────────────── ─────── ─────────────────
anthropic    ✓ authenticated     12  env (ANTHROPIC_API_KEY)
openai       ✓ authenticated      8  cli (~/.config/github-copilot)
google       ✓ authenticated     15  env (GOOGLE_API_KEY)
ollama       ✓ local              6  none (local)
openrouter   ✗ no credentials     0  —
nvidia       ✓ authenticated     42  env (NVIDIA_API_KEY)
together     ✓ authenticated     38  env (TOGETHER_API_KEY)
fireworks    ✓ authenticated     25  env (FIREWORKS_API_KEY)
groq         ✓ authenticated     12  env (GROQ_API_KEY)
mistral      ✓ authenticated      8  env (MISTRAL_API_KEY)
deepinfra    ✓ authenticated     50  env (DEEPINFRA_API_KEY)
cohere       ✓ authenticated      6  env (CO_API_KEY)
cerebras     ✓ authenticated      4  env (CEREBRAS_API_KEY)
perplexity   ✓ authenticated      8  env (PERPLEXITY_API_KEY)
```

### `kosha roles --role embeddings`

```
Provider     Model                                   Mode       Roles
──────────── ─────────────────────────────────────── ────────── ───────────────────────────────
openai       text-embedding-3-small                  embedding  embedding
google       text-embedding-004                      embedding  embedding
```

### `kosha cheapest --role image --limit 2`

```
Provider     Model                                   Mode       Metric      Score    $/M in  $/M out
──────────── ─────────────────────────────────────── ────────── ──────── ────────── ──────── ────────
openrouter   openai/dall-e-3                         image      blended     $8.00    $8.00    $0.00
openrouter   black-forest-labs/flux-1-schnell        image      blended    $10.00   $10.00    $0.00
```

### `kosha capabilities`

```
Capability           Models
──────────────────── ──────
chat                     38
vision                   12
function_calling         10
code                      8
embedding                 6
image_generation          4
audio                     2
```

### `kosha capable vision --limit 3`

```
Provider     Model                              Mode       Context    $/M in   $/M out
──────────── ────────────────────────────────── ────────── ────────── ──────── ────────
anthropic    claude-sonnet-4-20250514           chat       200K       $3.00    $15.00
openai       gpt-4o                             chat       128K       $2.50    $10.00
google       gemini-2.5-pro-preview-05-06       chat       1M         $1.25    $10.00
```

### `kosha routes gpt-4o`

```
Model: gpt-4o
Preferred provider: openai

Provider     Origin     Base URL                     Direct  Preferred
──────────── ────────── ──────────────────────────── ─────── ─────────
openai       openai     https://api.openai.com       ✓       ✓
openrouter   openai     https://openrouter.ai        —       —
```
