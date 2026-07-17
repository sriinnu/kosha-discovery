# Configuration

## Programmatic

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
    "my-model": "claude-sonnet-5",
  },
});
```

## Model Aliases

Built-in aliases for common models:

| Alias | Resolves To | Notes |
|-------|-------------|-------|
| `fable` | `claude-fable-5` | Latest Anthropic Fable |
| `sonnet` | `claude-sonnet-5` | Latest Anthropic Sonnet |
| `sonnet-5` | `claude-sonnet-5` | Sonnet 5 family |
| `sonnet-4` | `claude-sonnet-4-6` | Legacy Sonnet 4 family |
| `opus` | `claude-opus-4-8` | Latest Anthropic Opus |
| `opus-4` | `claude-opus-4-8` | Opus 4 family |
| `opus-4.8` | `claude-opus-4-8` | Specific Opus 4.8 |
| `haiku` | `claude-haiku-4-5-20251001` | Latest Anthropic Haiku |
| `kimi` | `kimi-k3` | Latest Moonshot Kimi |
| `gpt4o` | `gpt-4o` | OpenAI GPT-4o |
| `o3` | `o3` | OpenAI reasoning |
| `gemini-pro` | `gemini-2.5-pro-preview-05-06` | Google Gemini 2.5 Pro |
| `nemotron-ultra` | `nvidia/llama-3.1-nemotron-ultra-253b-v1` | NVIDIA Nemotron |
| `mistral-large` | `mistral-large-latest` | Mistral Large |
| `groq-llama` | `llama-3.3-70b-versatile` | Groq-hosted Llama |
| `embed-small` | `text-embedding-3-small` | OpenAI embedding |
| `nomic` | `nomic-embed-text` | Nomic embedding |

Custom aliases:

```typescript
import { ModelRegistry } from "kosha-discovery";
const registry = new ModelRegistry({ aliases: { "fast": "claude-haiku-4-5-20251001" } });
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

## Pricing Enrichment

Model pricing is sourced from [litellm's model pricing database](https://github.com/BerriAI/litellm) -- a community-maintained dataset covering 300+ models. Kosha fetches this data and enriches discovered models with:

- Input/output token pricing
- Reasoning token pricing (when provided by upstream)
- Batch API pricing (async batch input/output discounts, when available)
- Context window sizes
- Cache read/write costs
- Capability flags (vision, function calling, etc.)
- Origin-provider reference pricing for proxied routes (e.g. OpenRouter vs direct provider)
