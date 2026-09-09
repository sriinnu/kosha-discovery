# HTTP API Reference

Start the server:

```bash
kosha serve --port 3000
# or
PORT=3000 node dist/server.js
```

The server binds `127.0.0.1` by default. To expose it, pass `--host 0.0.0.0` (or set
`KOSHA_HOST`) **and** set `KOSHA_PROXY_TOKEN`; the proxy routes and `POST /api/refresh`
then require `Authorization: Bearer <token>` or `x-kosha-token: <token>`. See
[security.md](security.md#server-exposure-defaults).

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
  "id": "claude-sonnet-5",
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
  "resolved": "claude-sonnet-5",
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

### `GET /api/capabilities`

Aggregate view of every capability tag across the catalog, with the models that carry each.

Query: `?provider=<id>` scopes the summary to one serving-layer provider.

```json
{
  "capabilities": [{ "capability": "vision", "count": 212, "providers": ["anthropic", "openai", "..."] }],
  "count": 18,
  "missingCredentials": []
}
```

### `GET /api/discovery-errors`

Errors captured during the most recent discovery pass, one row per failing provider.

```json
{ "errors": [{ "providerId": "groq", "providerName": "Groq", "error": "…", "timestamp": 1784284454132 }], "count": 1, "hasErrors": true }
```

### `GET /metrics`

Prometheus text exposition (`text/plain; version=0.0.4`). Gauges for catalog size, discovery degradation, per-provider reliability / p95 latency / breaker state, proxy request and error counters, month-to-date spend and budget headroom, and pricing-provenance coverage. All metrics live under the `kosha_` prefix.

Set `KOSHA_METRICS_TOKEN` to require `Authorization: Bearer <token>`; unset leaves the endpoint open. See [operations.md](operations.md) for alert thresholds.

## OpenAI-compatible proxy

Point any OpenAI SDK at `http://127.0.0.1:3000/proxy/v1`. When `KOSHA_PROXY_TOKEN` is set, every proxy route requires it as `Authorization: Bearer <token>` or `x-kosha-token: <token>`.

### `GET /proxy/v1/models`

OpenAI-shaped model list containing every chat model the proxy can forward. SDKs call this before their first completion.

### `POST /proxy/v1/chat/completions`

Accepts a standard OpenAI chat-completions body. `model` is one of:

| Form | Example | Meaning |
|------|---------|---------|
| canonical ID or alias | `claude-sonnet-5`, `sonnet`, `gpt-4o-mini` | resolve, pick the best credentialed route, forward |
| `kosha:<strategy>` | `kosha:cheapest`, `kosha:fastest`, `kosha:reliable`, `kosha:balanced` | pick a route by strategy |
| `kosha:<strategy>[filters]` | `kosha:cheapest[tool_use,128k,provider:groq]` | strategy plus capability / min-context / provider filters |

Behaviour:

- **Failover.** Up to three ranked candidates are tried; a 5xx or network error rolls to the next, a 4xx is returned as-is. `x-kosha-attempt-chain` lists `provider:status` for every attempt.
- **Anthropic bridging.** Anthropic routes are translated to and from `/v1/messages` — streaming, tools / tool calls, `image_url` parts, `response_format` (json_schema on Claude 4.5+), and `reasoning_effort` are all carried. Sampling parameters are dropped on Claude generations that reject them; any lossy mapping is reported in `x-kosha-wire-notes`. Audio / file parts and non-function tools fall over to a native OpenAI-compatible route (OpenRouter, Vercel, …) when one is credentialed, otherwise `422`.
- **Budget gate.** With `KOSHA_MONTHLY_BUDGET_USD` set, requests over budget return `429` with `x-kosha-budget-remaining-usd` / `x-kosha-budget-usd`. An unreadable ledger fails closed with `503`.
- **Tenant bucketing.** `x-kosha-tenant: <name>` (or the legacy `Authorization: Bearer kosha-tenant-<name>` when no operator token is set) tags ledger rows and scopes the budget. It is a label, not authentication.

Response headers:

| Header | Meaning |
|--------|---------|
| `x-kosha-model` / `x-kosha-provider` | what actually ran |
| `x-kosha-requested` | the caller's original `model` string |
| `x-kosha-attempt-chain` | `provider:status,…` failover trail |
| `x-kosha-estimated-cost-usd` | pre-flight estimate from request size and pricing |
| `x-kosha-actual-cost-usd` / `x-kosha-usage-source` | reconciled cost from the upstream `usage` block when available (non-streaming) |
| `x-kosha-wire-notes` | Anthropic translator notes (dropped or degraded fields) |

Error responses on the Anthropic path use the OpenAI error envelope (`{ "error": { "message", "type", "code" } }`) so SDK clients parse them.

## MCP server

`kosha-mcp` (or `node dist/mcp-server.js`) exposes the registry over the Model Context Protocol on stdio. See [mcp.md](mcp.md).

## Discovery Plane v1

For the additive daemon-oriented contract (stable schema, deltas, live watch, execution-binding hints), see [discovery-plane-v1.md](discovery-plane-v1.md).
