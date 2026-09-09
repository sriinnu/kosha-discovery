# Security

Kosha applies zero-trust guardrails to all external data -- every API response, CLI output, cache read, and enrichment fetch is scanned before use.

## Runtime Payload Scanning

All external data passes through `assertCleanPayload()` which deep-scans every key and string value for 9 threat types:

| Threat | What it catches |
|--------|----------------|
| `credential_leak` | `sk-*`, `AKIA*`, `ghp_*`, `gho_*`, `xoxb-*`, `xoxp-*`, `AIza*`, `ya29.*`, `glpat-*`, `npm_*`, `pypi-*`, `hf_*`, Bearer tokens |
| `base64` | 32+ char base64-encoded blobs (credential exfiltration) |
| `script_injection` | `<script>`, `javascript:`, `on*=` event handlers |
| `shell_injection` | `$(cmd)`, backtick execution, pipe/chain to curl/wget/bash |
| `data_uri` | `data:text/html`, `data:application/*` |
| `null_byte` | `\x00`, `\u0000`, `%00` |
| `proto_pollution` | `__proto__` keys |
| `hex_payload` | 64+ char hex blobs |
| `oversized_string` | Values >2048 chars |

### Gated Ingestion Points

The scanner is applied at 5 chokepoints covering all external data:

1. **`base.ts` fetchJSON** -- all 15+ provider API responses
2. **`litellm.ts`** -- LiteLLM pricing JSON from GitHub
3. **`vertex.ts`** -- gcloud CLI model list output
4. **`bedrock.ts`** -- AWS CLI model list output
5. **`cache.ts`** -- cached data from disk (poisoned files are logged and auto-invalidated)

## Server Exposure Defaults

`kosha serve` fronts an OpenAI-compatible proxy that forwards requests using **your**
provider API keys. Two defaults keep that from becoming a free LLM endpoint for
whoever shares your network:

| Control | Default | Override |
|---------|---------|----------|
| Bind address | `127.0.0.1` (loopback only) | `kosha serve --host 0.0.0.0` or `KOSHA_HOST=0.0.0.0` |
| Operator token | unset (open, safe only on loopback) | `KOSHA_PROXY_TOKEN=<secret>` |

When `KOSHA_PROXY_TOKEN` is set, every `/proxy/*` route and `POST /api/refresh` require
the token as `Authorization: Bearer <token>` or in an `x-kosha-token` header. Comparison
is constant-time. Read-only catalog routes (`/api/models`, `/health`, ...) stay open;
`/metrics` has its own `KOSHA_METRICS_TOKEN`.

Binding a non-loopback address with no token set prints a warning at startup but does
not refuse to start -- some deployments terminate auth at a reverse proxy.

Tenant bucketing (per-tenant ledger rows and budgets) uses the `x-kosha-tenant: <name>`
header. The legacy `Authorization: Bearer kosha-tenant-<name>` form still works when
no operator token is configured. Neither is authentication.

## Pre-Commit Hook

A git pre-commit hook (`hooks/pre-commit`) provides 3-layer commit-time defense:

1. **Forbidden files** -- blocks `.env*`, `*.pem`, `*.key`, `*.p12`, `credentials.json`, `service-account*.json`
2. **Credential scan** -- scans staged diffs for 15+ secret patterns (OpenAI, AWS, GitHub, Slack, Google, GitLab, npm, PyPI, Hugging Face, etc.)
3. **Base64 in configs** -- scans staged `.json`/`.yaml`/`.toml` files for encoded blobs

Auto-installed on `npm install` via the `prepare` script. Bypass with `--no-verify` for legitimate cases (e.g. test fixtures with fake credentials).

## .gitignore

Hardened to block:

- `.env*`, `.env.local`, `.env.*.local`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`
- `credentials.json`, `service-account*.json`, `service_account*.json`
- `.npmrc`, `.pypirc`
- Local config overrides (`*.local.json`, `*.local.yaml`, etc.)

## Background

These guardrails were motivated by the LiteLLM supply-chain attack where base64-encoded credentials were injected into a community-maintained JSON file. Kosha takes a zero-tolerance stance: base64 and secrets are never expected in model metadata, pricing data, or provider API responses.
