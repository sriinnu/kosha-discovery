# Operations

Running kosha as a shared proxy for a team or platform. This is the runbook for sizing a deployment, scraping its metrics, minding the spend ledger, and recovering from each known failure mode. For the resilience model that backs the recovery recipes here, read [Resilience](resilience.md) first.

## Deployment sizing

Kosha is a single Node.js process (`node >=22`) — a Hono app served by `@hono/node-server`. It does two jobs in one process: a discovery layer that fans out to provider APIs on a schedule, and a proxy layer that forwards OpenAI-compatible requests to the winning provider.

- **CPU:** light. Discovery is network-bound and runs on demand (`POST /api/refresh`) or on boot; the proxy forwards request bodies untouched, so it spends its time in I/O, not compute.
- **Memory:** the model catalog lives in memory. It is small — hundreds to low thousands of model cards — so a 512 MB container is comfortable.
- **Concurrency:** bounded by upstream latency. Each proxied request holds open one upstream connection for as long as the provider takes, capped at 30 s (see [Hung upstream](#hung-upstream)). Size for your peak concurrent chat requests, not your request rate.
- **Disk:** local. kosha writes a discovery cache, the v1 manifest, and the spend ledger under `~/.kosha/` (override with the cache dir setting). Back this path up — it is also the recovery source when live discovery fails.
- **Credential boundary:** kosha resolves upstream credentials from env vars and CLI files (see [Credentials](credentials.md)). A shared proxy therefore implies shared access to those credentials — run one kosha per trust boundary rather than one for the whole org.

Start it behind a reverse proxy that handles TLS and retries:

```bash
PORT=3000 KOSHA_HOST=0.0.0.0 KOSHA_PROXY_TOKEN=<secret> KOSHA_MONTHLY_BUDGET_USD=500 node dist/server.js
```

## The spend ledger

Each proxied completion appends one JSONL row to a **monthly partition** at `~/.kosha/ledger-YYYY-MM.jsonl` (UTC). Each row carries a timestamp, provider, model, the original requested model, an optional tenant tag, an estimated USD cost, input/output token estimates, and the upstream status. Appends go to the current month's partition, so concurrent processes never clobber each other and the live file never grows without bound.

A legacy `~/.kosha/ledger.jsonl` left by pre-1.3.0 installs is still **read** for backward-compatible history (so the current month's budget still counts any pre-upgrade spend), but it is no longer written to.

Costs are **estimates** — there is no tokenizer in the hot path. kosha approximates input tokens from the `messages` payload with a deliberately conservative chars-per-token ratio and assumes a default output length when the caller omits `max_tokens`. Treat ledger totals as a directional spend signal, not an invoice.

### Monthly budget gate

Set `KOSHA_MONTHLY_BUDGET_USD` and the proxy enforces it per request. Spend is summed over the **current UTC calendar month** (`readSpendForMonth` reads only that month's partition plus any legacy rows). The cap is **global** — always compared against total spend, never a tenant's slice, so a caller cannot escape it by sending a fresh tenant tag. Set `KOSHA_TENANT_BUDGET_USD` for an additional per-tenant cap; while it is set, requests with no tenant tag share one `untagged` bucket, so leaving the tag off doesn't skip the cap.

Both values are plain dollar amounts (`500`, `12.5`). `0` is a real budget: nothing paid goes through, while $0 routes (local runtimes, plans you hold) still run. Anything else (`$50`, `1,000`, `50usd`, `-3`) stops `kosha serve` at start, and the proxy answers `503` until it's fixed; it is never read as "no budget". When either cap is hit the proxy returns `429` with two headers:

```
x-kosha-budget-remaining-usd: 0.0000
x-kosha-budget-usd: 500.00
```

If the ledger is unreadable (permissions, partial mount), the proxy **fails closed** with `503 budget enforcement unavailable` — it will not treat an unreadable ledger as "spent $0".

Streamed requests are reconciled too: the proxy asks the upstream for `stream_options.include_usage` and drops that usage chunk again if the caller didn't ask for it. A provider that answers `400` to the option gets the request again without it, and isn't asked again for the life of the process.

Tenants are labels: send `x-kosha-tenant: <name>` on a proxied request (or, when no `KOSHA_PROXY_TOKEN` is set, the legacy `Authorization: Bearer kosha-tenant-<name>`) and that caller's spend is bucketed under the tag. `kosha spend --tenant <name>` reports it; `KOSHA_TENANT_BUDGET_USD` caps it.

Streaming responses write their row **before** the body is relayed, carrying the pre-flight estimate; when the stream ends with a usage block, a second `kind: "adjustment"` row records the delta to the actual cost. Summing every row's contribution (`ledgerRowUsd`) therefore yields actual spend, and a client that disconnects mid-stream is still charged its estimate.

### Rotation and retention

Retention is **automatic**. On every append, kosha trims partition files older than the retention window (default **12 months**, tunable via `KOSHA_LEDGER_RETENTION_MONTHS`) via `trimLedgerPartitions`. The trim never touches the current month, never touches the legacy `ledger.jsonl`, and is best-effort (a trim failure never fails the request). The on-disk footprint is bounded without any operator action.

To keep more or less history, set the env var before starting the server:

```bash
KOSHA_LEDGER_RETENTION_MONTHS=24 node dist/server.js
```

Roll a final summary before a partition ages out with `kosha spend` (which reads every partition plus the legacy file):

```bash
kosha spend --since 2026-06-01 --until 2026-07-01 --json > ~/spend-june.json
```

The manual `awk` rotation recipes from pre-1.3.0 are no longer needed — and should not be used, since they would operate on a `ledger.jsonl` that has stopped growing.

## Metrics

`GET /metrics` returns Prometheus text exposition (`text/plain; version=0.0.4`). Scrape it directly — no sidecar, no extra dependency.

### Discovery-layer health (live)

| Metric | Type | What it tells you |
|--------|------|-------------------|
| `kosha_models_total` | gauge | Models the registry currently knows about. A sudden drop signals a botched discovery pass. |
| `kosha_providers_total` | gauge | Providers tracked. |
| `kosha_provider_reliability{provider}` | gauge | Reliability score in `[0,1]` per provider. |
| `kosha_provider_p95_latency_ms{provider}` | gauge | Observed p95 latency per provider, when available. |
| `kosha_provider_breaker_open{provider}` | gauge | `1` when the provider's circuit breaker is open, else `0`. |
| `kosha_discovery_errors_total` | gauge | Errors captured during the most recent discovery pass. |

### Proxy and spend signals

Per-request observability rides on **response headers** rather than a counters endpoint — wire your gateway or log pipeline to capture them:

| Header | Meaning |
|--------|---------|
| `x-kosha-model` / `x-kosha-provider` | The model and provider that actually served the request. |
| `x-kosha-requested` | The model string the caller sent (alias or `kosha:cheapest[…]` hint). |
| `x-kosha-attempt-chain` | The failover sequence tried, e.g. `anthropic:200` or `groq:503,openai:200`. |
| `x-kosha-estimated-cost-usd` | Pre-flight cost estimate for this request. |
| `x-kosha-actual-cost-usd` / `x-kosha-usage-source` | Cost reconciled from the upstream `usage` block, and whether it came from `upstream` or is the `estimate` (non-streaming responses). |
| `x-kosha-wire-notes` | Anthropic translator notes: fields dropped, clamped, or degraded to fit the target model. |
| `x-kosha-budget-remaining-usd` / `x-kosha-budget-usd` | Budget state (present on the `429` budget-exceeded response). |

Monthly spend and budget-remaining are also queryable any time from the ledger:

```bash
kosha spend --since 2026-07-01     # this month so far
```

The prometheus exposition is being extended to surface proxy request/error counters and spend/budget gauges under the same `kosha_*` namespace; confirm the exact names against your running `/metrics` output before alerting on them.

### Suggested alerts

- **`kosha_provider_breaker_open{provider} == 1` for > 10m** — a provider has failed three times and is short-circuited. Page the on-call if it is a primary provider.
- **`kosha_provider_reliability{provider} < 0.8`** — sustained failures; investigate before the breaker trips.
- **`kosha_provider_p95_latency_ms{provider}` above your tolerance** — a provider is slow; consider rerouting via `kosha:fastest[…]` or dropping it from preferred routes.
- **`kosha_discovery_errors_total` rising across passes** — check `/api/discovery-errors`; a credentials expiry or upstream outage is usually the cause.
- **`kosha_models_total` drops by > 20% pass-over-pass** — discovery regressed; fall back to the last-good manifest rather than serving a hollow catalog.
- **Budget headroom < 15%** (`x-kosha-budget-remaining-usd` / `x-kosha-budget-usd`) — raise `KOSHA_MONTHLY_BUDGET_USD` or trim traffic before the `429`s start.

## Recovery recipes

### Budget ledger out of sync

If the ledger is corrupt, ballooning, or you need to reset spend mid-month (for example after a test loop inflated it), archive and truncate it — see [Rotation and retention](#rotation-and-retention). Removing the file entirely is also safe: a missing ledger reads as `$0 spent this month`, so enforcement simply starts over. Do not patch rows in place; the file is append-only by contract.

### Force-refresh a provider after an outage

Providers self-heal through the circuit breaker (3 failures → open → 60 s cooldown, doubling up to a 1 h cap → half-open probe → close on success). To force the issue once the upstream is back:

```bash
curl -X POST http://localhost:3000/api/refresh \
  -H 'content-type: application/json' \
  -d '{"provider":"anthropic"}'
```

Or from the CLI:

```bash
kosha update          # full re-discovery, bypasses cache
```

A successful refresh records a success and closes the breaker. There is no HTTP endpoint to force-reset a breaker, and breaker state lives in memory — if a provider is stuck open after a flap, a process restart clears it immediately.

### Hung upstream

Each proxied upstream fetch must return headers (and, for non-streaming calls, its body) within 30 seconds; once a streamed body starts relaying, only the client hanging up or a kosha shutdown ends it, so long Claude / GPT streams are never cut by the proxy. On top of that, the proxy aborts in-flight upstream requests when kosha itself is shutting down, so a wedged provider cannot block a clean restart. Within a request, the proxy fails over across up to three ranked candidate routes — a 5xx or network error rolls to the next provider rather than returning the error. If one provider is consistently slow, its breaker opens after three consecutive failures and traffic routes around it automatically. `x-kosha-attempt-chain` on the response shows exactly which providers were tried.

### Clear a quarantined price

On every manifest merge, kosha compares fresh rates to the previous snapshot. Every rate that bills or ranks is compared: per-token, cache, batch, image, audio, video, per-character, per-request and long-context. A rate that moved by 75% or more in either direction is treated as a suspect publish (a provider returning 0, garbage units, a realignment). The old pricing is kept, and the row is tagged `pricing_quarantined` so downstream consumers aren't silently over- or undercharged. The held price is also the one kosha itself uses. It's copied back into the in-memory registry and the cache, so `cheapest`, the MCP tools, the proxy and the budget all see the held rate and the tag. Smaller moves (25%+) are logged to `~/.kosha/anomalies.json` as a heads-up and don't block the update.

Each move is also compared with an anchor: the highest input and output rates accepted in the last 30 days, kept on the manifest row as `priceAnchor`. A price below half the anchor, or above 4× it, is held even when each step was small, so a price can't walk down 15% at a time. One real 50% cut goes straight through; a second inside 30 days waits. A move back up toward the anchor is a correction and is taken at once. After 30 days without a new high, the current price becomes the anchor.

A hold is released by waiting: after a day if two sources agree on the new rate, three days if only one lists it, and seven while they disagree. There are two exceptions. A billed input or output rate that falls to `$0`, and any rate cut to under 1% of the last one, are never released by waiting. While a row is held, or its sources disagree, kosha routes and budgets on the highest rate any source reports. A suspect rise therefore applies right away; a suspect drop waits.

A secondary rate (cache, audio, image…) that a catalog suddenly reports as `0` keeps its last real value. A `$0` cache-read rate on a paid model is costed as unknown (half or a tenth of input, depending on the API shape), not as free.

To accept a large price change once you've checked it against the provider's own pricing page:

```bash
kosha registry accept anthropic/claude-opus-4-7
kosha update
```

The acceptance covers exactly the rates the hold is waiting on. If the catalog publishes something different afterwards, that's judged afresh.

The manifest is also the baseline every price is checked against. So a manifest that can't be read falls back to its newest `.bak.<YYYY-MM-DD>` copy rather than accepting every fresh price unchecked. Deleting `registry.json` doesn't clear holds while backups exist.

#### The weekly snapshot

The published snapshot (`snapshot-latest`) goes through the same quarantine, judged against the snapshot published before it, because it seeds `pinned` users, the catalog-outage fallback and first runs. A suspect cut is published at the previous price, tagged `pricing_quarantined`, and listed under "Prices held" in that week's release notes. A suspect rise is published at the higher price right away. The snapshot runs weekly, so every hold window has passed by the next run: a real cut reaches snapshot users a week late. A collapse to `$0` or under 1% waits until a maintainer releases it from the workflow's manual run:

```bash
gh workflow run update-kosha-snapshot.yml -f accept=openrouter/deepseek/deepseek-v4.1-flash-1017
```

The hold state rides on each published card (`pricingHold`, `priceAnchor`, `lastSeenAt`) so the next week can continue it. kosha drops those fields when it reads the snapshot; a local install keeps its own clock.

### Boot degraded mode

On startup kosha runs `discover()`, which loads from the on-disk cache under `~/.kosha/` first. If every provider API is down at boot, kosha still comes up serving the last-good catalog from that cache — live discovery never crashes the server, because each provider's outcome is settled independently and a failure simply omits that provider. The worst case is a boot with no prior cache and all providers unreachable: the server binds with an empty catalog rather than refusing connections.

Once the outage passes, a single `POST /api/refresh` (or restart) re-runs discovery and overwrites `~/.kosha/registry.json` atomically (write-to-tmp, then rename), with a `.bak.<YYYY-MM-DD>` ring kept for rollback. If you suspect the cache itself is poisoned, force a bypass:

```bash
kosha refresh         # ignores the cache and re-fetches every provider
```

Models that disappear from a provider for many consecutive passes are pruned automatically once unseen for 30 days, so a transient outage won't leave the catalog full of ghosts, and a restored provider re-populates on the next refresh.
