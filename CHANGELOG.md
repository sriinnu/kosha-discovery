# Changelog

All notable changes to **kosha-discovery** (कोश) are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are ordered newest-first. The public surface is the `@sriinnu/kosha-discovery`
npm package; the stable JSON contract consumed by Chitragupta and other daemons
is tracked separately via `DISCOVERY_SCHEMA_VERSION` (v1 as of 0.8.0).

---

## [Unreleased]

Nothing yet.

---

## [1.6.0] — 2026-09-19

### Fixed

- **One upstream model name was silently disabling every keyless provider
  fallback.** The `base64` threat rule flagged the models.dev catalog key
  `deepinfra/thinkingmachines/Inkling` — 33 characters, mixed case, entirely
  within the base64 alphabet — and because the scan was all-or-nothing, kosha
  rejected the *whole* 222-provider catalog. On a machine without API keys (the
  common case) that meant NVIDIA, Together, Fireworks, Groq, Mistral, DeepInfra,
  Cohere, Cerebras, Perplexity, MiniMax and GLM all reported **zero models**,
  with nothing in `discoveryErrors()` to say why. Live discovery went from 917
  models across 23 providers to 2,458 across 34 once fixed.
- **Moonshot pointed at the wrong region.** The sole `moonshot` provider used
  `api.moonshot.cn`, the mainland-China host, which an international key cannot
  authenticate against. `moonshot` is now `api.moonshot.ai` and `moonshot-cn`
  carries the China host.
- **GLM had no keyless fallback at all.** models.dev publishes it under the
  `zhipuai` slug, which was missing from the seed map, so keyless GLM discovery
  returned nothing.
- **An auth failure was reported as a missing endpoint.** The OpenAI-compatible
  endpoint chain walked past a 401 to a fallback path that never existed and
  reported *that* path's 404, hiding every expired-key diagnosis. Only a 404
  now advances to the next candidate; a 401/403/429 is reported as-is.
- **A provider whose model-list path 404s no longer reports zero models** — it
  falls back to the public catalog, since a gap in kosha's URL knowledge is not
  the same as a provider having no models.
- **The stale-but-offline path resolved aliases to nothing.** The curated
  fallback lists predated GPT-5 and still pinned retired `gemini-*-preview-*`
  snapshots, so with no key *and* no network, `kosha model gpt5` and
  `kosha model gemini-pro` resolved to IDs with no card behind them.
- **A catalog entry with no `case` in the credential resolver silently resolved
  to no credential.** The resolver now derives env vars from the provider
  descriptor by default, so adding a catalog entry is enough.

### Added

- **A separate rate for 1-hour cache writes.** Providers that offer more than
  one cache lifetime charge more for the longer one — Anthropic bills a
  5-minute write at 1.25× input and a 1-hour write at 2× — but every catalog we
  ingest (models.dev, LiteLLM, OpenRouter, Vercel) publishes a single
  `cache_write` rate, which is the short one. `ModelPricing` gains
  `cacheWrite1hPerMillion`, `TokenUsage` gains `cacheWrite1hTokens` (read from
  Anthropic's `cache_creation.ephemeral_1h_input_tokens`; a subset of the write
  total, never added to it), and cost reconciliation prices that share at its
  own rate — falling back to the published 2× input ratio for Anthropic-shaped
  usage rather than billing a 1-hour write as if it were a 5-minute one.
  Consumers that cache exclusively at 1 hour, as Claude Code does, were
  under-counting every cache write by a factor of 1.6. Pricing-anomaly
  detection watches the new rate too.

- **TypeSafe (System One / Jev) as a first-class provider.** `GET
  /v1/models` on `api.typesafe.ai`, credentials from `TYPESAFE_API_KEY` or
  `JEV_API_KEY`, documented 64k request / 32k state limits, and input-only
  pricing ($0.042/M in, $0 out — a typed judgment emits no billable
  completion). Alias: `jev`.
- **New `judgment` model mode**, plus a matching trusted capability and role.
  System One models answer a question with a choice, probability, or score
  rather than generating text, so tagging them `chat` would let a router send
  them prompts they cannot answer. Threaded through the v1 discovery contract,
  the HTTP mode enum, and the MCP tool schema.
- **xAI (Grok) as a direct provider.** `api.x.ai/v1`, `XAI_API_KEY`, with Grok
  Imagine split into `image` and `video` modes. xAI was already referenced as an
  *origin* provider and already had seed-catalog slugs wired — the direct
  provider itself was missing, so those slugs were dead code and no direct Grok
  route ever appeared in `kosha routes`.
- **Thinking Machines (Inkling).** Tinker serves it over an Anthropic-wire
  endpoint with no model-list path, so it is discovered seed-only. Alias:
  `inkling`.
- **Regional provider pairs, priced independently.** `alibaba` / `alibaba-cn`,
  `siliconflow` / `siliconflow-cn`, `moonshot` / `moonshot-cn`, `minimax` /
  `minimax-cn`, `stepfun` / `stepfun-cn`. The same model ID can cost very
  different amounts per region — Qwen 2.5 72B is $1.40/M international against
  $0.574/M in China — so merging the regions would make a model's price depend
  on which host answered last.
- **Nine further providers**: Alibaba Model Studio (Qwen), Volcengine Ark
  (Doubao), Inception Labs (Mercury), AI21 (Jamba), Upstage (Solar), Baseten,
  Nebius Token Factory, Novita AI, SiliconFlow, Hugging Face Inference
  Providers, Ollama Cloud. 25 providers → 45, counting the regional pairs.
- **`control_chars` and `bidi_override` threat rules.** kosha prints
  catalog-derived model names straight to a terminal, so an ESC byte in an
  upstream name could clear the screen, rewrite earlier output, or set the
  window title — enough to make `kosha list` show a different model than the one
  it routes to. Bidi and zero-width overrides ("trojan source") make text render
  unlike its bytes.
- **`excessive_nesting` rule.** A few megabytes of `[[[[…]]]]` previously
  overflowed the stack inside the scanner before any field was read.
- **base64 detection now decodes rather than only guessing.** Any string in the
  base64 alphabet is decoded and its plaintext re-scanned for credential,
  script, and shell patterns, so an encoded key is caught on its contents
  regardless of character distribution.
- **`quarantineEntries()`** for the large community catalogs: a tripping entry
  is dropped and recorded (`modelsDevQuarantined()`, `liteLLMQuarantined()`)
  instead of taking the whole feed down. A feed where more than half the entries
  trip still fails closed, and a poisoned top-level key is never quarantined.

### Changed

- **Adding an OpenAI-compatible provider is now a table entry, not a class.**
  `GenericOpenAICompatibleDiscoverer` takes the four things that actually vary
  (base URL, model-list path, origin derivation, which IDs to keep) as data in
  `GENERIC_OPENAI_PROVIDERS`. Providers with genuinely non-trivial
  classification — OpenRouter, Vercel, Groq — keep their own discoverers.
- Aliases added: `grok`, `jev`, `inkling`, `qwen-max`, `qwen-plus`,
  `qwen-coder`, `jamba`, `solar`, `mercury`, `doubao`.
- GLM additionally accepts `ZHIPU_API_KEY`, the name models.dev documents.

---

## [1.5.1] — 2026-09-12

### Changed

- **README and SKILL.md rewritten as accurate, dev-facing references**
  (were drifted / marketing-toned in places): correct provider count (25),
  current model IDs and pricing, the full HTTP and proxy surface, current
  `ModelCard` / `LedgerEntry` shapes, and a corrected "Adding a provider"
  walkthrough. `kosha --help` now documents `doctor` and `spend`, which
  existed but weren't listed.

### Fixed

- **Two real CodeQL `js/file-system-race` findings.** `KoshaCache.get()`
  and `registry-runtime.ts`'s manifest-backup rotation each did a
  path-based existence/size check followed by a separate path-based
  read — a window in which the path could be swapped between the two
  calls. Both now read through a single already-open file descriptor
  (`fstat` + read on the same handle) instead, closing the gap outright
  rather than re-checking it.
- **Lock-contention test rewritten** to remove the same pattern from its
  own fixture setup: it now holds one file handle for the whole test and
  reads before/after snapshots through it at an explicit byte position,
  rather than reopening the lock file by path — which also makes the
  assertion strictly stronger (same inode untouched, not just matching
  bytes at that path).

---

## [1.5.0] — 2026-09-09

Security defaults for the proxy, a current-generation Anthropic model layer,
full Anthropic bridging through the OpenAI-compatible proxy (streaming, tools,
images, structured output) with ledger usage reconciliation, MCP parity, and a
toolchain refresh. 929 tests; `pnpm audit` clean.

### Added

- **Proxy: full Anthropic bridging** (`src/wire-anthropic.ts`). The OpenAI ↔
  Anthropic translator now carries streaming (Anthropic SSE →
  `chat.completion.chunk` SSE, `[DONE]`, optional usage chunk via
  `stream_options.include_usage`), `tools` / `tool_choice` /
  `parallel_tool_calls`, assistant `tool_calls` → `tool_use`, `tool` role →
  `tool_result`, `image_url` parts (URL and base64 data URLs), `response_format`
  (`json_schema` → `output_config.format` on Claude 4.5+, `json_object` → system
  instruction), `reasoning_effort` → `output_config.effort` (clamped to the
  target generation's ladder), and `max_completion_tokens`. Responses translate
  `tool_use` blocks into OpenAI `tool_calls`, `refusal` into `content_filter`,
  and cache read / write tokens into `prompt_tokens` +
  `prompt_tokens_details.cached_tokens`.
- **Proxy: usage reconciliation.** Ledger rows now record the upstream `usage`
  block when the provider returns one (Anthropic JSON and SSE, OpenAI-compatible
  JSON and SSE with `include_usage`) as `actualUsd` / `actualInputTokens` /
  `actualOutputTokens` / cache token counts, tagged `usageSource: "upstream"`;
  the pre-flight estimate is kept alongside. Budget enforcement and
  `kosha spend` prefer the actual figure. New headers
  `x-kosha-actual-cost-usd`, `x-kosha-usage-source`, `x-kosha-wire-notes`.
- **Operator token for the proxy.** `KOSHA_PROXY_TOKEN` gates every `/proxy/*`
  route and `POST /api/refresh` (`Authorization: Bearer <token>` or
  `x-kosha-token`), constant-time compared. `x-kosha-tenant` header as the
  tenant-tag carrier so `Authorization` is free for the token.
- **`kosha serve --host <address>`** and `KOSHA_HOST`; the server logs a warning
  when bound to a non-loopback address without a proxy token.
- **Anthropic discoverer reads live Models API metadata** — `max_input_tokens`,
  `max_tokens`, and the nested `capabilities` tree now populate context window,
  output cap, and capability tags directly instead of waiting for LiteLLM
  enrichment (`capabilityTagsFromAnthropicApi`).
- **MCP:** `kosha_ranked_routes` tool (cheapest / fastest / reliable /
  balanced, same filters as `kosha_cheapest_model`); `ping` handler; protocol
  negotiation across `2025-06-18`, `2025-03-26`, `2024-11-05`;
  `serverInfo.version` read from `package.json`; tool failures returned as
  `isError` results per spec; JSON-RPC handler exported and unit-tested; stdio
  loop only starts when the file is the process entry point (symlink-safe).
- **Docs:** `docs/mcp.md`; `docs/api.md` now covers `/api/capabilities`,
  `/api/discovery-errors`, `/metrics`, and the proxy routes.
- **CI:** Node 22 + 24 matrix.

- **Ledger adjustment rows.** Streaming responses now write their request row
  (pre-flight estimate) the moment the upstream accepts the call, and a
  `kind: "adjustment"` row with the delta once the stream reports usage.
  `ledgerRowUsd` / `isRequestRow` make every reader agree; `kosha spend`
  counts requests, not rows.
- **`KOSHA_TENANT_BUDGET_USD`** — optional per-tenant monthly cap, applied in
  addition to the global cap.
- **Translator:** `user` → `metadata.user_id`; `temperature` clamped to
  Anthropic's 0..1; empty `stop` sequences dropped; `strict` tool flag dropped
  on generations without strict tool use; forced `tool_choice` degraded to
  `auto` when combined with `response_format` json_schema; `max_tokens`
  clamped to the model's output cap; streamed no-argument tool calls end with
  `"{}"` so SDKs can `JSON.parse`; fields with no Anthropic equivalent (`n`,
  `seed`, `logit_bias`, penalties, logprobs) reported in `x-kosha-wire-notes`.
- **Shared `src/claude-generation.ts`** — one parser for Claude IDs (bare,
  `vendor/` prefixed, dotted, Bedrock-suffixed) used by both the catalog
  feature inference and the proxy translator. New exports:
  `parseClaudeGeneration`, `claudeEffortLadder`, `claudeSupportsPrefill`.
- **MCP:** stdin EOF now waits for in-flight tool calls before exiting, so
  one-shot / piped invocations get their answer.

### Changed

- **Public API notes:** `OpenAIChatMessage.content` is now
  `string | Array<unknown> | null` (assistant tool-call turns carry `null`);
  `parseTenantTag` is exported and takes an optional second `x-kosha-tenant`
  argument; `LedgerEntry` gained optional reconciliation fields;
  `kosha spend --json` reports `reconciledRows`.
- **Global budget is global.** `KOSHA_MONTHLY_BUDGET_USD` is always compared
  against total spend; previously a request carrying a tenant tag was checked
  only against that tenant's slice, so a fresh tag per request escaped the cap.
- **Upstream timeout covers headers and non-streaming bodies only.** Streamed
  bodies are no longer cut at 30 s; the shutdown signal and the client
  disconnect end them.
- **Default aliases track the current Claude generation:** `fable` →
  `claude-fable-5-1`, `opus` → `claude-opus-5`, `haiku` → `claude-haiku-4-5`
  (bare ID, not the dated snapshot). New pins `fable-5.1`, `mythos`, `opus-5`,
  `opus-4.7`, `sonnet-4.6`; `fable-5`, `opus-4`, `opus-4.8`, `sonnet-4` keep
  their previous targets. `gpt5` / `gpt5-mini` / `gpt5-nano` / `gpt5-pro` /
  `gpt4.1` added; `gemini-pro` / `gemini-flash` / `gemini-flash-lite` moved from
  retired 2025 preview IDs to the `gemini-2.5-*` GA IDs.
- **Static Anthropic fallback catalog** gains `claude-fable-5-1` and
  `claude-opus-5`, uses bare IDs, and carries context / output limits plus
  `reasoning`, `structured_output`, `prompt_caching` capability tags.
- **`inferStructuredOutputModes` for Anthropic:** Claude 4.5+ report
  `json-schema` (native `output_config.format`); Fable / Mythos 5.1 drop
  `tool-choice` because forced tool use returns a 400 on them.
- **`kosha serve` binds `127.0.0.1` by default** (was every interface). Pass
  `--host 0.0.0.0` to restore the old behaviour — and set `KOSHA_PROXY_TOKEN`.
- **`/metrics` token comparison is constant-time.**
- **Toolchain:** TypeScript 7, Vitest 5, Biome 2.5.12, `@types/node` 26.5;
  `hono` 4.13.7 and `@hono/node-server` 2.1.1; GitHub Actions moved to
  `checkout@v7`, `setup-node@v7`, `upload-artifact@v7`, `pnpm/action-setup@v6`,
  `codeql-action@v4`, `action-gh-release@v3` (Node 20 runner deprecation).
- **npm tarball drops `logo.png`** (3.3 MB of a 3.6 MB package); `logo.svg`
  stays. Package size 3.6 MB → 0.3 MB.

### Fixed

- **Paid-but-unrecorded requests.** Three paths could bill the upstream and
  leave no ledger row: a client disconnecting mid-stream (the usage promise
  never settled), a stream longer than 30 s (the body shared the header
  timeout), and a non-ASCII caller string reflected into a response header
  (undici rejects it → 500 after the upstream call). The row is now written
  before any body is relayed, stream transformers settle on cancel, and header
  values are reduced to printable ASCII.
- **Translator 400s on real generations:** `output_config.effort` was sent to
  Sonnet 4.5 / Haiku 4.5 (only Opus 4.5 has effort); both `temperature` and
  `top_p` were forwarded on Claude 4.0 / 4.1 / 4.5 (every 4.x accepts one); a
  trailing assistant turn was shipped as a prefill to 4.6+ (rejected) and a
  trailing `tool_use` without its result was shipped to every generation — a
  minimal user turn is now appended and noted.
- **Quadratic bearer-token parse** on gated routes replaced with a linear one.
- **Anthropic SSE parser** now caps its buffer (1 MiB) and scans each byte
  once; a malformed upstream ends the stream with an OpenAI error chunk.
- **Negative token counts** from a broken upstream are clamped so a reconciled
  cost can never drive spend below zero.
- **Capability tree keys** are looked up as own properties (`constructor` no
  longer resolves to a function); boolean `supported` leaves are accepted.
- **Snapshot workflow artifact** no longer includes the tee'd autofetch log
  (secrets are masked in step logs but not in artifacts).
- **Snapshot workflow never ran.** `update-kosha-snapshot.yml` referenced
  `runner.temp` in a job-level `env`, which GitHub rejects at parse time, so
  every run (the Monday cron included) failed in 0 s and `data/kosha-latest.json`
  froze at 2026-07-17. Paths are now resolved in a step; provider API keys are
  passed from repository secrets so the commit guard can pass.
- **Anthropic translator sent `temperature` / `top_p` to models that reject
  them** (Opus 4.7+, Sonnet 5, Fable, Mythos → 400). Sampling params are now
  dropped per generation (and reduced to one on Opus / Sonnet 4.6).
- **Anthropic translator synthesized an empty user message** for system-only or
  assistant-first conversations, which Anthropic rejects; a non-empty
  placeholder is used. Trailing whitespace on a final assistant turn is trimmed.
- **Cost estimate ignored `max_completion_tokens`.**

### Security

- `hono` 4.12.28 → 4.13.7: ReDoS in CORS middleware, `memo()` cross-request
  SSR leak, language-middleware complexity DoS, proxy-helper `Connection`
  header handling. `@hono/node-server` 2.0.8 → 2.1.1: unauthenticated
  memory-leak DoS via aborted WebSocket handshake. Transitive `postcss`
  8.5.x path-traversal advisories cleared via Vite 8.2.2. `pnpm audit` clean.

---

## [1.4.0] — 2026-07-17

### Added

- **Tally export** (`src/tally.ts`) exposed via `src/index.ts` and
  `package.json` conditional export `"./tally"`. Pure, zero-dependency
  token-usage normalization + USD cost aggregation for browser/edge
  consumers.
- **Moonshot aliases** — `kimi` and `kimi-k3` resolve to `kimi-k3`.

### Changed

- **Updated default Anthropic aliases** (`src/aliases.ts`) to current model IDs:
  - `opus` / `opus-4` / `opus-4.8` → `claude-opus-4-8`
  - `sonnet` / `sonnet-5` → `claude-sonnet-5`
  - `fable` / `fable-5` → `claude-fable-5`
  - `sonnet-4` preserved as a backward-compat alias for `claude-sonnet-4-6`.
- **Updated Anthropic static fallback catalog** (`src/discovery/static-direct.ts`)
  to include `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`, while
  keeping `claude-sonnet-4-6` for the legacy `sonnet-4` alias.

### Fixed

- `normalizeTokenUsage()` no longer rejects cache-write-only or
  reasoning-only usage records when input and output tokens are both zero.

---

## [1.3.1] — 2026-07-08

Architecture-review hardening pass (PR #36), tiers 1–6.

### Changed

- Proxy: fail-safe wire translation (unsupported content throws and fails over
  instead of being silently dropped), streaming failover across candidates,
  circuit-breaker wiring fed by real proxy outcomes.
- Registry: serialized `discover()`, lifecycle gating, pricing provenance
  attribution.
- Server: `/metrics` bearer-token gate and new gauges, boot-time degraded mode
  when discovery fails, graceful shutdown that aborts in-flight upstream
  fetches.
- Ledger: monthly partition rotation with retention trimming.
- CLI: `kosha doctor --ci`.
- Dependencies to latest; Vite 8 clears GHSA-fx2h-pf6j-xcff and
  GHSA-v6wh-96g9-6wx3.

---

## [1.3.0] — 2026-06-25

A broad release that hardens the proxy/runtime, expands routing intelligence,
adds cost tracking with a budget gate, brings the Anthropic wire format under
the OpenAI-compatible proxy contract, and lights up new operator surfaces.
789 tests; full security-extended CodeQL coverage outside three intentional
credential-forwarding / wire-translation / ledger-write paths (`src/proxy.ts`,
`src/wire-anthropic.ts`, `src/cost.ts`).

### Added

- **Health-aware routing engine** (`registry-routing.ts`). New
  `RouteStrategy = cheapest | fastest | reliable | balanced` folds the
  rolling latency/timeout observations and per-provider circuit-breaker state
  on top of the price-ranked candidate set. Open-breaker providers always
  sort last so the ranking is directly usable as a failover order. Public
  API: `ModelRegistry.rankedRoutes()`, `ModelRegistry.providerRouteHealth()`.
- **Proxy strategy selectors** — `kosha:fastest[…]`, `kosha:reliable[…]`,
  `kosha:balanced[…]` alongside the existing `kosha:cheapest`.
- **Proxy failover across ranked candidates** with `x-kosha-attempt-chain`
  response header (provider:status,…). 5xx and network errors fail over;
  4xx is the caller's own error and is surfaced as-is. Bounded to 3 actual
  upstream fetches per request.
- **Cost as first-class** (`src/cost.ts`).
  - `x-kosha-estimated-cost-usd` response header on every forwarded request.
  - JSONL spend ledger at `~/.kosha/ledger.jsonl`; caller-supplied string
    fields are sanitized (CR/LF/TAB stripped, length-bounded) before write.
  - Monthly budget gate via `KOSHA_MONTHLY_BUDGET_USD`; fails **closed**
    (503) when the ledger is unreadable, so a hostile or just-broken ledger
    cannot bypass the cap.
  - Per-tenant tagging via `Authorization: Bearer kosha-tenant-<name>` —
    bucketing label only; upstream credentials still resolve from env/CLI
    files as usual.
  - New `kosha spend` CLI (alias `kosha usage`) rolls the ledger up by
    provider / model / tenant with `--since`, `--until`, `--tenant`,
    `--json` flags.
- **OpenAI ↔ Anthropic wire-format translation** (`src/wire-anthropic.ts`).
  Lifts system messages to the top-level `system` field, flattens
  structured content, ensures user-first ordering, **collapses
  consecutive same-role messages** (Anthropic forbids them), defaults
  `max_tokens`, maps `stop_reason` onto the OpenAI vocabulary, reflects
  token usage. Proxy auto-detects `provider === "anthropic"` and routes
  via `/v1/messages` with `x-api-key` + `anthropic-version`. Streaming
  through the translator is intentionally rejected with a 422 for now.
- **SSRF guard.** `safeUpstreamUrl()` validates the resolved upstream
  hostname against a literal-string allowlist (catalog hosts + loopback
  for local runtimes) before `fetch` is issued. `buildUpstreamUrl()` for
  non-local providers reads **only** the in-process provider catalog
  `defaultBaseUrl`, never the disk-loaded `registry.baseUrl`.
- **Manifest merge — pricing quarantine + lifecycle TTL**. Per-million
  rate moves ≥75% in either direction keep the previous price block and
  tag the row `pricing_quarantined`. Models absent from the fresh fetch
  are kept with an incremented `missingRunCount`; dropped after 14
  consecutive absent runs.
- **Adaptive `CircuitBreaker`** — open-state cooldown doubles after each
  failed probe up to a 1h cap; resets to the base value on a successful
  close. New `currentResetTimeoutMs()` for diagnostics, new
  `maxResetTimeoutMs` option.
- **LM Studio + vLLM discoverers** (`/v1/models` on `:1234` and `:8000`).
  Provider catalog entries with loopback `defaultBaseUrl` and
  `openai-compatible-http` transport so the proxy auto-routes through
  them via the SSRF allowlist's loopback branch.
- **Watch & integrate.** `ModelRegistry.onChange(handler, onError?)` callback
  subscription (handler errors isolated from other subscribers). New
  `GET /metrics` endpoint in Prometheus text format —
  `kosha_models_total`, `kosha_providers_total`, per-provider
  `_reliability`, `_p95_latency_ms`, `_breaker_open`. Provider label values
  are fully escaped per the exposition spec (`\\`, `\"`, `\n`, no `\r`).
- **`kosha doctor`** (alias `kosha health`) — surfaces deprecation findings
  (`status`, `deprecationDate`, `daysUntilSunset`, `replacedBy`) and
  per-provider routing health. Supports `--json`.

### Changed

- **Credential resolver** now searches `$XDG_CONFIG_HOME/<tool>`,
  `~/.config/<tool>`, and (on Windows) `%APPDATA%\<tool>` for Claude /
  Codex / Gemini CLI configs, so non-default install layouts are no longer
  silently skipped.
- **Discovery base layer** — every discoverer now sends a default
  `User-Agent: kosha-discovery (+https://…)` (caller can override) and
  every `fetchJSON` call honours a **global deadline** across all retries +
  backoff sleeps, so a slow-but-alive provider can't stretch a single call
  to ~31s.
- **Provider catalog** now lists `lmstudio` and `vllm` as first-class
  local runtimes.

### Fixed

- **Google API key in URL → header.** `?key=…` query parameter replaced
  with `x-goog-api-key` header so the key cannot leak through proxy access
  logs, HTTP `Referer`, or any URL diagnostic path.
- **Cache JSON-bomb guard.** `KoshaCache.get()` rejects any cache file
  larger than 25 MiB before `JSON.parse`, and the rejection is logged with
  the key sanitized to prevent log injection.
- **Anthropic pagination cap.** Cursor-based pagination is now bounded by
  a hard page count in addition to `MAX_MODELS_PER_PROVIDER`, so a buggy
  `has_more: true` loop cannot spin forever.
- **AWS INI parser.** A section header missing its closing bracket
  (`[default`) used to silently match the wrong section; now skipped.
- **MCP server parse error.** Malformed JSON-RPC input now responds with
  `-32700 Parse error` (id null) instead of being dropped — clients no
  longer hang waiting on a missing reply.
- **Proxy `x-kosha-requested` header.** Control characters (CR/LF/NUL)
  stripped and length-bounded so a malformed model string can no longer
  produce a 500 via the `Headers` constructor.
- **`startOfMonth` / `startOfNextMonth` UTC.** Previously mixed UTC
  getters with the local-time `Date` constructor; replaced with
  `Date.UTC()` so monthly budget cutoffs don't drift in non-UTC timezones.
- **`rankCandidatesByStrategy` empty-set guard.** Returns `[]` instead of
  computing `Math.min(...[]) === Infinity` extremes.

### Security

- CodeQL config in `.github/codeql/codeql-config.yml`. Full
  `security-extended` pack continues to run on every other source file;
  `paths-ignore` carves out `src/proxy.ts`, `src/cost.ts`, and
  `src/wire-anthropic.ts` — the three files that own the intentional
  credential-forwarding and ledger-write patterns whose in-code defenses
  (host allowlist, ledger sanitization, budget fail-closed) are the
  load-bearing protections.

### Internal

- New public exports from `src/index.ts`: `RouteStrategy`, `RankedRoute`,
  `RouteHealth`, `parseRouteStrategy`, `ROUTE_STRATEGIES`, cost helpers
  (`estimateRequestCost`, `appendLedgerEntry`, `readSpendForMonth`,
  `readMonthlyBudgetUsd`, `DEFAULT_LEDGER_PATH`), translator helpers
  (`translateOpenAIToAnthropic`, `translateAnthropicToOpenAI`), and
  associated types.
- New optional `DiscoveryModelV1.missingRunCount` field on the v1
  discovery contract.

---

## [1.1.0] — 2026-05-08

### Added

- **OpenAI-compatible proxy** (`POST /proxy/v1/chat/completions`, `GET /proxy/v1/models`).
  Supports direct model IDs, aliases, and the `kosha:cheapest[capability,Nk,provider:X]`
  hint syntax. Uses the full 5-tier `CredentialResolver` (same sources as discovery) and
  streams responses back verbatim. Adds `x-kosha-model`, `x-kosha-provider`, and
  `x-kosha-requested` response headers.
- **MCP stdio server** (`kosha-mcp` bin). Implements the MCP 2024-11-05 protocol over
  stdin/stdout with no SDK dependency. Exposes 6 tools: `kosha_query_models`,
  `kosha_cheapest_model`, `kosha_model_detail`, `kosha_model_routes`,
  `kosha_resolve_alias`, `kosha_provider_health`. Registry loads in the background on
  startup so the first tool call is fast.
- **Pricing-diff anomaly log** — mismatches between the live API price and the local
  7-day snapshot ring now emit a `[kosha] pricing anomaly` warning (tagged `[promo]`
  for known promotional windows so operators can distinguish noise from real drift).
- **7-day snapshot ring** — the local registry manifest now keeps a rolling 7-entry
  history of pricing snapshots, enabling rollback to any of the last 7 states.
- **`DISCOVERER_REGISTRY`** — single source of truth for all 22 provider discoverers,
  replacing the previous duplicated lists. New `getDiscoverer(providerId)` export for
  targeted single-provider discovery.

### Fixed

- `primaryCredentialEnvVar` added to the `ProviderDescriptor` interface — it was used
  in catalog objects and `registry-runtime.ts` but missing from the type, breaking the
  TypeScript build.
- Proxy now falls back to `registry.modelRoutes()` when the primary provider card is
  not forwardable (e.g. requesting `claude-sonnet-4-6` with only an OpenRouter key now
  routes through OpenRouter instead of returning 422).
- `registryClassifyError`: `lower.includes("5")` replaced with `/\b5\d{2}\b/.test()`
  — the old check false-positived on model IDs and strings containing the digit 5.
- `applyPromoOverrides` pricing spread fixed: `{ ...match.pricing }` →
  `{ ...card.pricing, ...match.pricing }` so base fields are not silently dropped.
- `hasUsablePricing`: `> 0` → `!== undefined` — free-tier models (price = 0) were
  incorrectly excluded from cheapest-model results.

### Changed

- New K-lettermark logo (circuit-board K + keyhole, purple/gold).
- DeepSeek promo window extended to 2026-05-31.
- `fallbackRegistryCredential` now reads `primaryCredentialEnvVar` from the provider
  catalog instead of a hardcoded duplicate `FALLBACK_ENV_MAP`.

---

## [1.0.0] — 2026-04-28

### Changed

- Pricing-stability hardening promoted to stable. No API surface changes from 0.8.0.

---

## [0.8.0] — 2026-04-21

### Added

- **Tokenizer-family inference** (`inferTokenizerFamily`) for API-served
  models: `o200k_base`, `cl100k_base`, `claude`, `gemini`, `llama4`,
  `llama3`, `llama2`, `mistral`, `cohere`, `deepseek`, `qwen`. Local
  runtimes continue to surface the family via
  `LocalRuntimeMetadata.tokenizerFamily`; the enricher fills in API-served
  models from the origin + model ID.
- **Tool-dialect and structured-output inference** (`src/model-features.ts`):
  `inferToolDialect`, `inferStructuredOutputModes`, and
  `inferParallelToolCalls`. New union types `ToolDialect`,
  `StructuredOutputMode`, and `ModelStatus` exported from `@sriinnu/kosha-discovery`.
- **Multimodal pricing fields** on `ModelPricing`:
  `imageInputPerImage`, `imageOutputPerImage`, `audioInputPerMillion`,
  `audioOutputPerMillion`, `audioInputPerSecond`, `audioOutputPerSecond`,
  `videoInputPerSecond`, `videoInputPerMillion`,
  `inputPerMillionCharacters`, `outputPerMillionCharacters`,
  `longContextInputPerMillion`, `longContextOutputPerMillion`,
  `longContextThresholdTokens`. LiteLLM enrichment maps the matching
  fields (`input_cost_per_image`, `input_cost_per_audio_token`,
  `input_cost_per_audio_per_second`, `input_cost_per_video_per_second`,
  `input_cost_per_character`, `input_cost_per_token_above_128k_tokens`,
  `input_cost_per_token_above_200k_tokens`).
- **Deprecation / sunset metadata** on `ModelCard`: `status`,
  `deprecationDate`, `replacedBy`. Status is derived from litellm's
  `deprecation_date` (future date → `"deprecated"`, past date →
  `"retired"`, no date → `"active"`).
- **Llama 4 support** — tokenizer family tag (`"llama4"`), tool
  dialect routing, and structured-output mode inference for Scout /
  Maverick / Behemoth variants.
- **Provider prompt-cache prefix floor** — new
  `ProviderDescriptor.minCachePrefixTokens` field documenting the
  minimum prompt-prefix size required to engage a provider's prompt
  cache (1024 tokens for Anthropic and OpenAI today).
- **Additional capability flags** surfaced from litellm:
  `audio_input`, `audio_output`, `video_input`, `reasoning`,
  `structured_output`.
- **Parallel tool-call hint** (`ModelCard.supportsParallelToolCalls`)
  prefers litellm's `supports_parallel_function_calling` flag and
  falls back to a heuristic keyed on dialect + model ID.
- **v1 discovery-contract extensions** — `DiscoveryModelV1` now
  surfaces `toolDialect`, `structuredOutputModes`,
  `supportsParallelToolCalls`, `status`, `deprecationDate`, and
  `replacedBy`. All additions are optional / nullable, so v1
  consumers that ignore unknown fields remain compatible.

### Fixed

- GPT-3.5-turbo-1106 and 0125 now correctly report parallel tool-call
  support (`true`); earlier revision of `inferParallelToolCalls`
  wrongly returned `false`.
- LiteLLM `extractPricing` price-signal guard recognises
  multimodal-only entries (image-generation, TTS-per-second), so
  DALL-E-style and ElevenLabs-style models no longer drop through
  with undefined pricing.

### Changed

- The pricing-merge path in `LiteLLMEnricher` now tops up
  `cacheReadPerMillion`, `cacheWritePerMillion`, and the new
  multimodal fields per-field instead of all-or-nothing, so proxy
  routes (OpenRouter, etc.) can keep their markup prices while
  inheriting direct-origin cache and multimodal rates.
- `inferToolDialect` documentation now notes that managed serving
  layers (Groq, Together, Fireworks, OpenRouter) expose open-weight
  models behind an OpenAI-compatible tools API regardless of the
  underlying family; callers should consult `ModelCard.provider`
  first and fall back to this inference only for direct-origin routes.

### Security

- **hono** bumped 4.12.9 → 4.12.14, closing seven medium-severity
  advisories (JSX HTML injection, cookie-name bypass, cookie-name
  validation, `ipRestriction` IPv4-mapped IPv6, serveStatic repeated-slash
  bypass, `toSSG` path traversal, `@hono/node-server` serveStatic bypass).

### Tests

- 49 new tests across `test/model-features.test.ts`,
  `test/enrichment/litellm-2026.test.ts`, and `test/tokenizer-family.test.ts`
  covering tool dialects, structured-output modes, parallel tool calls,
  multimodal pricing, long-context tiers, deprecation status, and
  the Llama 4 family. Full suite: **660 tests passing**.

---

## [0.7.0] — 2026-04-01

### Added

- **Batch API pricing** (`batchInputPerMillion`, `batchOutputPerMillion`)
  on `ModelPricing`, wired end-to-end through the enrichment pipeline
  and discovery-v1 schema.
- CLI refactor: sub-modules each under 450 LOC, `pricing` view, and
  a dedicated `enrich` command.

### Changed

- Documentation and schema validation extended to cover the complete
  pricing surface (input, output, reasoning, cache, and batch).

---

## [0.6.x and earlier]

See git history and GitHub release notes for entries prior to 0.7.0.

[0.8.0]: https://github.com/sriinnu/kosha-discovery/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/sriinnu/kosha-discovery/releases/tag/v0.7.0
