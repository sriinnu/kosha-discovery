# Security

Kosha applies zero-trust guardrails to all external data -- every API response, CLI output, cache read, and enrichment fetch is scanned before use.

## Runtime Payload Scanning

All external data passes through `assertCleanPayload()` which deep-scans every key and string value for 12 threat types:

| Threat | What it catches |
|--------|----------------|
| `credential_leak` | `sk-*`, `AKIA*`, `ghp_*`, `gho_*`, `xoxb-*`, `xoxp-*`, `AIza*`, `ya29.*`, `glpat-*`, `npm_*`, `pypi-*`, `hf_*`, Bearer tokens |
| `base64` | 32+ char base64 blobs, by character distribution **or** by decoding them and re-scanning the plaintext |
| `script_injection` | `<script>`, `javascript:`, `on*=` event handlers |
| `shell_injection` | `$(cmd)`, backtick execution, pipe/chain to curl/wget/bash |
| `data_uri` | `data:text/html`, `data:application/*` |
| `null_byte` | `\x00`, `\u0000`, `%00` |
| `control_chars` | C0/C1 control characters and DEL — ANSI/terminal escape injection |
| `bidi_override` | Bidi and zero-width formatting overrides ("trojan source") |
| `proto_pollution` | `__proto__` keys |
| `hex_payload` | 64+ char hex blobs |
| `oversized_string` | Values >2048 chars |
| `excessive_nesting` | Payloads nested deeper than 64 levels |

### Terminal escape injection

Kosha prints catalog-derived model IDs and names straight to a terminal. An ESC
byte in an upstream model name is enough to move the cursor, clear the screen,
rewrite output already printed, or set the window title — so a provider could
make `kosha list` display a different model than the one it routes to. The
`control_chars` and `bidi_override` rules catch this at ingestion, which covers
the CLI, the HTTP API, and the MCP server in one place rather than escaping at
each print site.

### How `base64` decides

A character-class heuristic alone cannot separate real base64 from a namespaced
model ID: `deepinfra/thinkingmachines/Inkling` is 33 characters drawn entirely
from the base64 alphabet. Requiring a digit alongside mixed case separates the
two, because base64 of random bytes is digit-dense while hand-written
identifiers often are not. Measured over 200k samples, a random 32-byte blob's
base64 lacks a digit 0.06% of the time, and an `sk-`-shaped ASCII key never did.

The remaining gap is closed by decoding rather than guessing: any string in the
base64 alphabet is decoded and the plaintext re-scanned for credential, script,
and shell patterns. An encoded key is caught on its contents regardless of how
its characters happen to be distributed.

### Quarantine vs. rejection

`assertCleanPayload()` rejects the whole payload, which is right for data kosha
depends on in full — a provider's own `/v1/models` response, a cache file it
wrote itself.

It is the wrong policy for the large community catalogs. models.dev aggregates
200+ contributors and LiteLLM thousands of model entries, so an all-or-nothing
scan lets any one contributor's unusual model name disable **every** keyless
provider fallback at once. Those two loaders use `quarantineEntries()` instead:
a tripping entry is dropped and recorded (`modelsDevQuarantined()`,
`liteLLMQuarantined()`), and the rest of the catalog still loads. A feed where
more than half the entries trip is not one bad row — that still fails closed.

A poisoned top-level *key* (`__proto__`, a null byte) is never quarantined: it
is a structural attack on the object, so the feed is rejected outright.

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
| Allowed `Host` names | loopback only | `KOSHA_ALLOWED_HOSTS=kosha.internal,…` (`*` for any) |

When `KOSHA_PROXY_TOKEN` is set, every `/proxy/*` route and `POST /api/refresh` require
the token as `Authorization: Bearer <token>` or in an `x-kosha-token` header. Comparison
is constant-time. Read-only catalog routes (`/api/models`, `/health`, ...) stay open;
`/metrics` has its own `KOSHA_METRICS_TOKEN`.

Binding a non-loopback address with no token set prints a warning at startup but does
not refuse to start -- some deployments terminate auth at a reverse proxy.

Loopback is not a boundary against the browser: any web page can send requests to
`127.0.0.1`, and a DNS-rebinding page can read the replies. So every route refuses a
`Host` header that is not loopback or in `KOSHA_ALLOWED_HOSTS` (rebinding), an `Origin`
that does not match `Host`, and `Sec-Fetch-Site: cross-site` (cross-site requests).
Non-browser clients send no `Origin` and are unaffected. A server bound to a network
interface skips the `Host` check unless `KOSHA_ALLOWED_HOSTS` is set; the `Origin` check
always applies. Bodies are capped at 32 MiB on `/proxy/*` and 64 KiB on `/api/refresh`.

Tenant bucketing (per-tenant ledger rows and budgets) uses the `x-kosha-tenant: <name>`
header. The legacy `Authorization: Bearer kosha-tenant-<name>` form still works when
no operator token is configured. Neither is authentication.

## Pre-Commit Hook

A git pre-commit hook (`hooks/pre-commit`) provides 3-layer commit-time defense:

1. **Forbidden files** -- blocks `.env*`, `*.pem`, `*.key`, `*.p12`, `credentials.json`, `service-account*.json`
2. **Credential scan** -- scans staged diffs for 15+ secret patterns (OpenAI, AWS, GitHub, Slack, Google, GitLab, npm, PyPI, Hugging Face, etc.)
3. **Base64 in configs** -- scans staged `.json`/`.yaml`/`.toml` files for encoded blobs (a blob is 40+ base64 characters with upper, lower and digit; the test is on the blob, not the line)

Hits that match a pattern in `.secret-allowlist` (one extended regex per line) are dropped. It holds SSH key fingerprints, which the release workflow pins on purpose.

Auto-installed on `pnpm install` via the `prepare` script (`prepare` does not run for consumers of the package). Bypass with `--no-verify` for legitimate cases (e.g. test fixtures with fake credentials).

## .gitignore

Hardened to block:

- `.env*`, `.env.local`, `.env.*.local`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`
- `credentials.json`, `service-account*.json`, `service_account*.json`
- `.npmrc`, `.pypirc`
- Local config overrides (`*.local.json`, `*.local.yaml`, etc.)

## Release Integrity

LiteLLM's `1.107.0` (October 21, 2026) was not a bug in LiteLLM's code. Stolen
GitHub CLI tokens from three engineers modified the release workflow, built from
a lookalike repository, approved the production gate and deleted the logs; PyPI
and Docker Hub shipped a credential stealer for two hours. kosha's data feed
from LiteLLM was never affected (kosha reads one JSON file from `main`, which
was untouched, through the scan above), but kosha has the same shape of release
path, and a kosha release holds the same loot: provider keys in the environment.

So the release path assumes a maintainer token will be stolen, and asks for the
one thing a token cannot produce: a hardware signature.

| Layer | What it stops |
| --- | --- |
| Release tags signed with a FIDO2 key; `.github/allowed_signers` pins the keys | A pushed tag with no touch on the key |
| Workflow verifies the tag against signers read from `main`, fingerprints pinned in the workflow, and requires the commit to be on `main` | A tag at a commit that never went through `main`'s signed-commit rule |
| Tag rulesets: signed commits and no deletion on `v*`, no moving `v*.*` | Retagging a shipped version, erasing the trail |
| `npm-release` environment: only `v*` tags, reviewer required | A dispatch from a side branch with an edited workflow |
| npm trusted publishing bound to repo + workflow + environment; no npm token anywhere | The token a stealer would take; publishing from any other run |
| npm provenance on every version | Verifying after the fact what built the tarball |
| Action pinned to its own release version, `--ignore-scripts` | Every consumer's CI pulling a fresh publish within minutes |
| `minimumReleaseAge: 10080` for dependencies | Installing a package poisoned an hour ago |

The ceiling is honest: a token with administration scope can edit the rulesets
and the environment. That is why the maintainer's CLI token is a fine-grained
token without `workflow`, `actions` or `administration` permissions, and
releases are dispatched and approved from a browser session behind a passkey.

## Background

These guardrails were motivated by the LiteLLM supply-chain attack where base64-encoded credentials were injected into a community-maintained JSON file. Kosha takes a zero-tolerance stance: base64 and secrets are never expected in model metadata, pricing data, or provider API responses.

The counterweight, learned the hard way: a tripwire that fails closed over an
entire feed is itself an availability bug. One legitimate model name published
upstream (`deepinfra/thinkingmachines/Inkling`) tripped the base64 rule and made
kosha reject the whole models.dev catalog — silently zeroing every provider that
had no API key, which is most of them on a fresh machine. The fix was not to
weaken the defence but to make it precise (decode instead of guess) and to
narrow its blast radius (quarantine the entry, not the feed).
