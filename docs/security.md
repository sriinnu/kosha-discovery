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
