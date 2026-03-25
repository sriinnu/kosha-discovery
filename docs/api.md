# HTTP API Reference

Start the server:

```bash
kosha serve --port 3000
# or
PORT=3000 node dist/server.js
```

## Endpoints

### `GET /api/models`

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

### `GET /api/models/cheapest`

Rank the cheapest eligible models for a role/capability.
Useful for assistant routers asking: _"For embeddings, what is cheapest right now?"_

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

### `GET /api/roles`

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

### `GET /api/models/:idOrAlias`

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

### `GET /api/models/:idOrAlias/routes`

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

### `GET /api/providers`

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

### `GET /api/providers/:id`

Get a single provider with all its models.

```bash
curl http://localhost:3000/api/providers/anthropic
```

### `POST /api/refresh`

Trigger re-discovery of all providers, or a specific one.

```bash
# Refresh all
curl -X POST http://localhost:3000/api/refresh

# Refresh a specific provider
curl -X POST http://localhost:3000/api/refresh -H "Content-Type: application/json" -d '{"provider": "anthropic"}'
```

### `GET /api/resolve/:alias`

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

### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "models": 234,
  "providers": 16,
  "uptime": 123.45
}
```

## Discovery Plane v1

For the additive daemon-oriented contract (stable schema, deltas, live watch, execution-binding hints), see [discovery-plane-v1.md](discovery-plane-v1.md).
