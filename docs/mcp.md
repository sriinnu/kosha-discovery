# MCP Server

`kosha-mcp` exposes the local kosha registry to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io) using newline-delimited JSON-RPC 2.0 on stdio. No HTTP server, no network listener: the agent spawns the process and talks over pipes.

## Setup

Claude Code:

```bash
claude mcp add kosha -- kosha-mcp
```

Any MCP client config (Claude Desktop, Cursor, Zed, …):

```json
{
  "mcpServers": {
    "kosha": { "command": "kosha-mcp" }
  }
}
```

Without a global install, use `npx -y -p @sriinnu/kosha-discovery kosha-mcp` as the command.

The registry is loaded lazily on the first tool call, so starting the server has no network side effects (it reads only its own `package.json` for the version). Discovery honours the same credential sources and cache as the CLI (`~/.kosha/`).

## Protocol

The server implements MCP revisions `2025-06-18`, `2025-03-26`, and `2024-11-05`. On `initialize` it echoes the client's `protocolVersion` when it is one of those, otherwise it answers with the newest it supports. `ping` returns `{}`. `serverInfo.version` is the installed package version.

Tool-execution failures (a provider timing out, a model not found) come back as a `tools/call` result with `isError: true` so the model can read the message and recover. Malformed JSON-RPC requests are `-32600`; unknown tools or malformed parameters/arguments are `-32602`; unknown methods are `-32601`.

## Tools

| Tool | Purpose | Key arguments |
|------|---------|---------------|
| `kosha_query_models` | List / filter models | `provider`, `mode`, `capability`, `limit` |
| `kosha_cheapest_model` | Cheapest models you can call that meet the requirements; remote $0 prices rank last with `priceUnverified: true`. A cheaper route you can't call comes back as `cheapestOverall` with a `toCall` hint | `capability`, `min_context_k`, `provider`, `limit`, `include_uncallable` |
| `kosha_ranked_routes` | Routes you can call, ranked by strategy, breaker-open providers last | `strategy` (`cheapest` / `fastest` / `reliable` / `balanced`), same filters as cheapest |
| `kosha_model_detail` | Full card for one model (pricing, capabilities, tool dialect, structured-output modes, status) | `model` |
| `kosha_model_routes` | Every serving-layer route for a model with per-route pricing | `model` |
| `kosha_resolve_alias` | Alias → canonical ID + provider | `alias` |
| `kosha_provider_health` | Auth state, model counts, last discovery error per provider | `provider` |
| `kosha_newest_models` | The newest models, newest first, on the maker's route; each row says how it was dated (`dateSource`: `release`, `route`, `first-seen`) and where else it's served (`alsoOn`) | `days`, `limit`, `provider`, `mode`, `include_resellers` |
| `kosha_context_strategy` | Ranked context-management options (continue / cache / compact / switch / batch) with per-turn cost math | `model`, `current_tokens`, `expected_output_tokens`, `expected_remaining_turns` |
| `kosha_compare_models` | Compare multiple models side-by-side (resolved pricing, context, capabilities, cache behavior, lifecycle status) | `models` |
| `kosha_estimate_cost` | Estimate request USD cost for explicit input, output, cache-read, and cache-write tokens | `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `service_tier` |
| `kosha_pricing_anomalies` | List >25% unexpected rate shifts recorded across catalog refreshes | `provider`, `limit` |
| `kosha_list_providers` | Providers with auth state, model count, prompt-cache behavior, and breaker health | `authenticated_only` |
| `kosha_refresh_registry` | Force a live refresh (all providers or a single provider) and return updated counts | `provider` |

## Resources

The server advertises `capabilities.resources` (`resources/list` and `resources/read`):

| URI | Description |
|-----|-------------|
| `kosha://snapshot` | Full canonical v1 discovery snapshot JSON |
| `kosha://providers` | Discovered providers with auth status, cache behavior, and route health |
| `kosha://anomalies` | Recorded >25% pricing-diff events from manifest merges |

Both tools return only routes you can call now, because an agent acts on row one. A route is callable when kosha holds a key the provider accepted, or the provider needs no key and answered on the last discovery. A Claude subscription token doesn't count: it can't make API calls. Every row carries `callable`, `credentialSource` and `keyVerified` (the live list answered with the key). `include_uncallable: true` lists every route; the rows you can't call say why in `uncallableReason` (`no-key`, `key-refused`, `subscription-oauth`, `unreachable`) and what to set in `toCall`. When nothing is callable, `matches` is empty and `message` says so; there is no silent fallback to routes you can't use.

`kosha_ranked_routes` is the tool to reach for before routing real traffic: `fastest` uses observed p95 latency, `reliable` folds in circuit-breaker state and timeout / auth-error history, `balanced` blends price, latency, and reliability. The returned order doubles as a failover sequence.

## Example exchange

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"kosha","version":"<installed version>"}}}
→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"kosha_ranked_routes","arguments":{"strategy":"reliable","capability":"tool_use","limit":3}}}
← {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{ \"strategy\": \"reliable\", \"routes\": [ … ] }"}]}}
```
