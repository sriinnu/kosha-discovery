# Contributing to kosha-discovery

Thanks for helping. Bug fixes, provider additions, and model data corrections are the most useful contributions; for anything larger, open an issue first so we can agree on the shape before you write it.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node 22 or newer and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```sh
git clone https://github.com/sriinnu/kosha-discovery.git
cd kosha-discovery
pnpm install
pnpm run check   # lint + build + tests, the same thing CI runs
```

`pnpm install` also installs `hooks/pre-commit`, which blocks commits that contain secrets, `.env` files, or credential-bearing configs. If it flags something that only looks like a secret (a fingerprint, a documented fake key), add a pattern to `.secret-allowlist` and say why in the PR.

Useful while working:

| Command | What it does |
|---|---|
| `pnpm test:watch` | vitest in watch mode |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint:all` | Biome with warnings, not just errors |
| `pnpm kosha <cmd>` | run the built CLI, e.g. `pnpm kosha list` |
| `pnpm aliases:check <snapshot.json>` | check `src/aliases.ts` against a discovery snapshot |

## Making a change

1. Branch off `main`.
2. Keep the change focused. One fix or feature per PR.
3. Add or update tests under `test/`. Discovery tests mock `fetch` and never call a real provider (see `test/discovery/typesafe.test.ts`).
4. For user-visible changes, add an entry under `[Unreleased]` in `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style).
5. Update `README.md` or `docs/` if flags, env vars, or behaviour changed. The wiki is generated from `docs/`, so don't edit it directly.
6. Run `pnpm run check` and open the PR. CI runs on Node 22 and 24.

PRs are squash-merged, so your branch's history doesn't need to be tidy, and the PR title becomes the commit message. Use [Conventional Commits](https://www.conventionalcommits.org/) for it: `fix(cli): ...`, `feat: ...`, `chore: ...`.

`main` only accepts signed commits. The squash commit GitHub creates is signed by GitHub, so you don't need a signing key to contribute, though signing your own commits is welcome.

## Project layout

```
src/
  cli.ts                 # CLI entry point and arg parsing
  cli-commands.ts        # command implementations (+ cli-cmd-*.ts for the larger ones)
  registry.ts            # ModelRegistry public API
  registry-runtime.ts    # discovery orchestration, enrichment, cache, manifest export
  registry-query.ts      # model / role / capability queries
  registry-selection.ts  # cheapest candidates, binding hints
  registry-routing.ts    # cheapest / fastest / reliable / balanced ranking
  discovery/             # one discoverer per provider + static and public-seed catalogs
  enrichment/            # models.dev + LiteLLM pricing enrichment
  credentials/           # credential resolution (env, CLI files, ADC, OAuth)
  provider-catalog.ts    # provider descriptors: base URLs, transport, env var names
  subscription-plans.ts  # token and coding plans, generated into provider descriptors
  catalog-source.ts      # community / pinned / local catalog modes, export envelope
  price-trust.ts         # rate sanitising and the $0 / unpriced rules
  snapshot-gate.ts       # price quarantine for the published weekly snapshot
  security.ts            # threat scan for every external payload
  resilience.ts          # circuit breakers and stale-cache fallback
  aliases.ts             # built-in short names → canonical model IDs
  claude-generation.ts   # which Claude generation accepts which API parameters
  model-features.ts      # tool dialect / structured-output inference per model
  proxy.ts               # OpenAI-compatible proxy: routing, failover, ledger
  wire-anthropic.ts      # OpenAI ↔ Anthropic request / response / SSE translation
  cost.ts                # spend ledger, budget gates, usage reconciliation
  tally.ts               # zero-dependency token usage + USD tally (also exported as ./tally)
  server.ts              # Hono HTTP API + operator token gate
  mcp-server.ts          # MCP stdio server
  types.ts               # shared types
```

## Adding a provider

For an OpenAI-compatible provider — most of them — it is two table entries, a catalog mapping and a test:

1. Add a descriptor to `PROVIDER_CATALOG` in `src/provider-catalog.ts` (id, base URL, transport, credential env vars).
2. Add a spec to `GENERIC_OPENAI_PROVIDERS` in `src/discovery/generic-openai.ts`. It registers its own discoverer, resolves credentials from the descriptor's `credentialEnvVars`, and falls back to the public catalog when there is no key.
3. Map the provider to its models.dev / LiteLLM slug in `src/discovery/modelsdev-seed.ts` and `litellm-seed.ts` so keyless discovery works. **Check the slug** — GLM is published as `zhipuai`, and a missing mapping means no keyless models at all.
4. Add a case to `test/discovery/generic-openai.test.ts` and document the env vars in `docs/credentials.md`.

Write a discoverer class only when classification genuinely needs code — per-route pricing (OpenRouter), a non-OpenAI response envelope (TypeSafe), or origin remapping (Vercel):

1. Create `src/discovery/<provider>.ts` extending `BaseDiscoverer` or `OpenAICompatibleDiscoverer`; `fetchJSON` and `makeCard` are provided.
2. Export it from `src/discovery/index.ts` and add a factory entry to `DISCOVERER_REGISTRY`.
3. Add a resolver branch in `src/credentials/resolver.ts` only for a bespoke search order (CLI files, OAuth, ADC, SSO). A plain API key in env vars needs no branch — the descriptor covers it.
4. Add `test/discovery/<provider>.test.ts` (mock `fetch`; see `typesafe.test.ts`).

## Fixing model data

Prices and limits come from the live provider API where there is one, then models.dev and LiteLLM, then kosha's snapshot. Before patching kosha, check which layer is wrong:

- If the public catalog is wrong, a fix upstream helps everyone. Link it in your PR.
- If the alias table is wrong, `src/aliases.ts` is hand-maintained; `pnpm aliases:check` shows drift.
- Always include a link to the provider's own pricing page or docs.

## Things that need extra care

- **The discovery JSON contract** (`src/discovery-contract.ts`, `DISCOVERY_SCHEMA_VERSION`) is consumed by other daemons. Additive fields are fine; renaming or removing anything is a breaking change and needs discussion first.
- **Credentials.** Keys are read at discovery time and must never be written to the cache, logs, error messages, or the pricing manifest. External payloads go through `src/security.ts`; keep it that way.
- **Dependencies.** kosha has two runtime dependencies on purpose. Adding one needs a good reason in the PR.
- **Workflows and `action.yml`.** Actions are pinned to commit SHAs. Keep new ones pinned too.

## Releases

Releases are cut by the maintainer from signed `v*` tags; the publish workflow verifies the signature and publishes through npm trusted publishing. Contributors don't need to bump versions or touch the release workflow. See [SECURITY.md](SECURITY.md#supply-chain) for how the release path is protected.

## Security issues

Don't open a public issue. Follow [SECURITY.md](SECURITY.md).
