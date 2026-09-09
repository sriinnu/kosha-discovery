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
| `fable` | `claude-fable-5-1` | Latest Anthropic Fable (most capable tier) |
| `fable-5` | `claude-fable-5` | Pinned Fable 5 |
| `mythos` | `claude-mythos-5-1` | Project Glasswing counterpart of Fable 5.1 |
| `opus` | `claude-opus-5` | Latest Anthropic Opus |
| `opus-5` | `claude-opus-5` | Pinned Opus 5 |
| `opus-4` / `opus-4.8` | `claude-opus-4-8` | Pinned Opus 4.8 |
| `opus-4.7` | `claude-opus-4-7` | Pinned Opus 4.7 |
| `sonnet` | `claude-sonnet-5` | Latest Anthropic Sonnet |
| `sonnet-5` | `claude-sonnet-5` | Pinned Sonnet 5 |
| `sonnet-4` / `sonnet-4.6` | `claude-sonnet-4-6` | Pinned Sonnet 4.6 |
| `haiku` / `haiku-4.5` | `claude-haiku-4-5` | Latest Anthropic Haiku (bare ID, not date-suffixed) |
| `kimi` | `kimi-k3` | Latest Moonshot Kimi |
| `gpt5` | `gpt-5` | OpenAI GPT-5 (`gpt5-mini`, `gpt5-nano`, `gpt5-pro` also) |
| `gpt4.1` | `gpt-4.1` | OpenAI GPT-4.1 |
| `gpt4o` | `gpt-4o` | OpenAI GPT-4o |
| `o3` | `o3` | OpenAI reasoning |
| `gemini-pro` | `gemini-2.5-pro` | Google Gemini 2.5 Pro (GA ID) |
| `gemini-flash` | `gemini-2.5-flash` | Google Gemini 2.5 Flash (GA ID) |
| `nemotron-ultra` | `nvidia/llama-3.1-nemotron-ultra-253b-v1` | NVIDIA Nemotron |
| `mistral-large` | `mistral-large-latest` | Mistral Large |
| `groq-llama` | `llama-3.3-70b-versatile` | Groq-hosted Llama |
| `embed-small` | `text-embedding-3-small` | OpenAI embedding |
| `nomic` | `nomic-embed-text` | Nomic embedding |

Custom aliases:

```typescript
import { ModelRegistry } from "kosha-discovery";
const registry = new ModelRegistry({ aliases: { "fast": "claude-haiku-4-5" } });
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
