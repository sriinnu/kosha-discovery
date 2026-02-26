# kosha-discovery

## Skill: AI Model Discovery

### Description

Kosha-discovery (कोश) provides AI model and provider discovery capabilities. It can:

- Discover available AI models across cloud providers (Anthropic, OpenAI, Google, OpenRouter) and local runtimes (Ollama)
- Resolve model aliases to canonical IDs (e.g., "sonnet" -> "claude-sonnet-4-6")
- Provide pricing information for token-based cost estimation
- Detect and enumerate local LLM instances
- Find credentials from CLI tools, environment variables, and config files

### When to Use

- When an application needs to know what AI models are available
- When selecting the cheapest/fastest/most capable model for a task
- When building multi-provider AI systems
- When routing between local and cloud models based on task complexity
- When estimating costs before making API calls

### Input

```typescript
// Library usage
import { createKosha } from "kosha-discovery";
const kosha = await createKosha();

// CLI usage
kosha list --provider anthropic --mode chat

// HTTP API
GET /api/models?provider=anthropic&mode=chat&capability=vision
```

### Output

```typescript
interface ModelCard {
  id: string;              // "claude-sonnet-4-6"
  name: string;            // "Claude Sonnet 4.6"
  provider: string;        // "anthropic"
  mode: ModelMode;         // "chat" | "embedding" | "image" | "audio"
  capabilities: string[];  // ["chat", "vision", "function_calling", "code"]
  contextWindow: number;   // 200000
  maxOutputTokens: number; // 16384
  pricing?: ModelPricing;  // { inputPerMillion: 3, outputPerMillion: 15 }
  aliases: string[];       // ["sonnet", "sonnet-4"]
  source: string;          // "api" | "litellm" | "local"
}
```

### Access Patterns

1. **Library** -- `import { createKosha } from "kosha-discovery"` (TypeScript/JavaScript)
2. **CLI** -- `kosha <command>` (terminal)
3. **HTTP API** -- `kosha serve --port 3000` (REST endpoints)

### Providers Supported

| Provider | Type | Auth Required |
|----------|------|--------------|
| Anthropic | Cloud | Yes (API key or Claude CLI) |
| OpenAI | Cloud | Yes (API key or Copilot) |
| Google | Cloud | Yes (API key or Gemini CLI) |
| OpenRouter | Aggregator | Optional |
| Ollama | Local | No |

### Dependencies

- Node.js >= 22
- Network access for cloud provider discovery
- Optional: Ollama running locally for local model discovery

### Related Skills

- Model routing (selecting optimal model for task complexity)
- Cost estimation (using pricing data for budget planning)
- Provider health checking (verifying API availability)
