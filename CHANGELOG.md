# Changelog

All notable changes to **kosha-discovery** (कोश) are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are ordered newest-first. The public surface is the `@sriinnu/kosha-discovery`
npm package; the stable JSON contract consumed by Chitragupta and other daemons
is tracked separately via `DISCOVERY_SCHEMA_VERSION` (v1 as of 0.8.0).

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
