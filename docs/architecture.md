# Kosha-Discovery Architecture

> कोश (kosha) -- treasury, storehouse of knowledge

## 1. Overview

Kosha-discovery uses a **two-layer architecture** to provide comprehensive,
accurate model information across all supported providers.

### Layer 1: Dynamic API Discovery

The first layer queries provider APIs in real time to get the **authoritative
list of available models**. Each provider has a dedicated discoverer that
authenticates, calls the model-listing endpoint, and normalizes the response
into a common `ModelCard` format. This layer answers: _"What models exist right now?"_

### Layer 2: Static Enrichment

The second layer augments dynamic data with **static metadata** from the
LiteLLM model cost database -- token pricing, context window sizes, max output
limits, and capability flags. This layer answers: _"What can each model do, and
what does it cost?"_

### Why Two Layers?

Provider APIs are inconsistent. Some return pricing (OpenRouter), most do not.
By combining live discovery with a curated static dataset, kosha provides a
**uniform, complete view** regardless of which provider you query.

```
    Provider APIs (live)        LiteLLM Database (static)
           |                            |
           v                            v
    +--------------+            +---------------+
    |  Discoverers |            |   Enrichers   |
    +--------------+            +---------------+
           |                            |
           +--------+    +-------------+
                    |    |
                    v    v
              +---------------+
              |  ModelRegistry |
              +---------------+
                     |
           +---------+---------+
           |         |         |
           v         v         v
        Library     CLI    HTTP API
```

---

## 2. Discovery Flow

### Steps

1. **Registry Initialization** -- `ModelRegistry` loads discoverers for the
   requested providers (or all by default).
2. **Credential Resolution** -- The credential resolver locates API keys per
   provider by walking a priority chain (see Section 3).
3. **Parallel Discovery** -- Discoverers run concurrently via
   `Promise.allSettled()`. A failing provider does not block others.
4. **Normalization** -- Raw API responses are converted into `ModelCard`.
5. **Enrichment** -- LiteLLM enricher fills pricing, context, and capabilities.
6. **Caching** -- Results are serialized to disk with a TTL. Subsequent
   requests within the TTL skip steps 2-5.
7. **Alias Resolution** -- Short names ("sonnet", "gpt4") are mapped to
   canonical model IDs.

```
  Request
    |
    v
  [Cache valid?] --yes--> Return cached models
    |no
    v
  [Resolve credentials] --> [Discover in parallel] --> [Normalize]
    --> [Enrich] --> [Write cache] --> [Build alias index] --> Return models
```

---

## 3. Credential Resolution

Credentials are resolved per-provider using a priority chain. The first source
that yields a valid key wins.

### Priority Chain

```
Explicit Key --> Env Var --> CLI Token --> Config File --> None (skip provider)
```

### Per-Provider Sources

| Provider | Env Var | CLI Token Path | Config Path |
|----------|---------|----------------|-------------|
| Anthropic | `ANTHROPIC_API_KEY` | `~/.claude/credentials.json` | `~/.config/claude/settings.json` |
| OpenAI | `OPENAI_API_KEY` | `~/.config/github-copilot/hosts.json` | `~/.config/openai/auth.json` |
| Google | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | `~/.config/gemini/credentials.json` | `~/.config/gcloud/application_default_credentials.json` |
| OpenRouter | `OPENROUTER_API_KEY` | -- | -- |
| Ollama | `OLLAMA_HOST` | -- | Default: `http://127.0.0.1:11434` |

All providers also accept an explicit key via `options.apiKey` (highest priority).

---

## 4. Module Map

```
src/
├── index.ts              Public API: createKosha(), ModelCard, ModelRegistry
├── types.ts              ModelCard, ModelMode, ModelPricing, ProviderName, etc.
├── registry.ts           ModelRegistry orchestrator (discovery + enrichment + cache)
├── aliases.ts            Alias resolution: short names --> canonical IDs
├── cache.ts              File-based JSON cache with TTL (~/.cache/kosha/)
├── cli.ts                CLI entry point, arg parsing
├── cli-format.ts         ANSI formatting + table rendering
├── cli-commands.ts       list, resolve, info, cache-clear, serve
├── server.ts             Hono REST API (/api/models, /api/resolve/:alias, etc.)
├── discovery/
│   ├── base.ts           Abstract BaseDiscoverer interface
│   ├── anthropic.ts      Anthropic /v1/models
│   ├── openai.ts         OpenAI /v1/models
│   ├── google.ts         Google /v1beta/models
│   ├── ollama.ts         Ollama /api/tags (local)
│   ├── openrouter.ts     OpenRouter /api/v1/models
│   └── index.ts          createDiscoverer() factory
├── enrichment/
│   ├── litellm.ts        LiteLLM pricing/context enrichment
│   └── index.ts          Enricher exports
└── credentials/
    ├── resolver.ts       Multi-source credential discovery
    └── index.ts          Credential exports
```

---

## 5. Data Flow Diagram

```
 EXTERNAL SOURCES                 KOSHA INTERNALS                  CONSUMERS
 ================                 ===============                  =========

 +----------------+
 | Anthropic API  |--+
 +----------------+  |        +----------------+
 | OpenAI API     |--+------->|  Discovery     |     +----------------+
 +----------------+  |        |  Layer         |     |                |
 | Google AI API  |--+        |  (parallel     |---->| ModelRegistry  |
 +----------------+  |        |   fetch +      |     |  .discover()   |
 | OpenRouter API |--+        |   normalize)   |     |  .list()       |
 +----------------+  |        +----------------+     |  .resolve()    |
 | Ollama (local) |--+               |               +-------+--------+
 +----------------+                  v                   |    |    |
                              +----------------+         v    v    v
 +----------------+           |  Enrichment    |       Lib  CLI  HTTP
 | LiteLLM JSON   |--------->|  Layer         |
 +----------------+           +----------------+
                                     |
 +----------------+                  v
 | Env / CLI /    |           +----------------+
 | Config files   |---------->|  Cache Layer   |
 +----------------+           |  (disk, TTL)   |
                              +----------------+
```

### Transformation Pipeline

```
Provider API Response (raw JSON)
  --> Extract fields (id, name, description, created, owner)
  --> Normalize to ModelCard (standardize names, infer mode, set provider)
  --> Enrich from LiteLLM (pricing, context, maxOutput, capabilities)
  --> Index & Alias (build lookups, register aliases, sort)
  --> Final ModelCard[] ready to query
```

---

## 6. Adding a New Provider

### Step 1: Define the Provider Name

Add to the `ProviderName` union in `src/types.ts`:

```typescript
export type ProviderName =
  | "anthropic" | "openai" | "google"
  | "openrouter" | "ollama"
  | "newprovider";  // <-- add here
```

### Step 2: Create the Discoverer

Create `src/discovery/newprovider.ts`:

```typescript
import { BaseDiscoverer } from "./base.js";
import type { ModelCard, DiscoverOptions } from "../types.js";

export class NewProviderDiscoverer extends BaseDiscoverer {
  readonly provider = "newprovider" as const;

  async discover(options: DiscoverOptions): Promise<ModelCard[]> {
    const apiKey = options.credentials?.["newprovider"];
    if (!apiKey) return [];

    const response = await fetch("https://api.newprovider.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return [];

    const data = await response.json();
    return data.models.map((m: any) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      provider: this.provider,
      mode: this.inferMode(m),
      capabilities: this.extractCapabilities(m),
      contextWindow: m.context_length ?? 0,
      maxOutputTokens: m.max_output ?? 0,
      pricing: undefined,
      aliases: [],
      source: "api",
    }));
  }
}
```

### Step 3: Register the Discoverer

Update `src/discovery/index.ts`:

```typescript
case "newprovider":
  return new NewProviderDiscoverer();
```

### Step 4: Add Credential Resolution

Update `src/credentials/resolver.ts`:

```typescript
case "newprovider":
  return options.apiKey ?? process.env.NEWPROVIDER_API_KEY ?? undefined;
```

### Step 5: Add Aliases

Update `src/aliases.ts` with short names for the new provider's models.

### Step 6: Write Tests

Create `test/discovery/newprovider.test.ts` covering:
- API response mocking and normalization verification
- Graceful failure handling
- Missing credentials (returns empty array)

### Step 7: Update Documentation

- Add the provider to the table in `SKILL.md`
- Add credential sources to Section 3 of this document
- Update the README with new environment variables

---

## Appendix: Key Design Decisions

**File-based caching** -- Kosha is used across CLI invocations. Disk cache
means `kosha list` in one terminal benefits from discovery in another.

**LiteLLM as enrichment source** -- Most comprehensive open-source database
of model pricing and capabilities, community-maintained and frequently updated.

**`Promise.allSettled()` over `Promise.all()`** -- A single provider failure
should not prevent results from others. Graceful degradation by design.

**Hono for HTTP** -- Lightweight, fast, multi-runtime (Node/Bun/Deno), minimal
dependency weight with a complete routing and middleware stack.
