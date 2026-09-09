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

The registry is loaded lazily on the first tool call, so starting the server has no filesystem or network side effects. Discovery honours the same credential sources and cache as the CLI (`~/.kosha/`).

## Protocol

The server implements MCP revisions `2025-06-18`, `2025-03-26`, and `2024-11-05`. On `initialize` it echoes the client's `protocolVersion` when it is one of those, otherwise it answers with the newest it supports. `ping` returns `{}`. `serverInfo.version` is the installed package version.

Tool-execution failures (a provider timing out, a model not found) come back as a `tools/call` result with `isError: true` so the model can read the message and recover. Unknown tools or malformed arguments are JSON-RPC `-32602`; unknown methods are `-32601`.

## Tools

| Tool | Purpose | Key arguments |
|------|---------|---------------|
| `kosha_query_models` | List / filter models | `provider`, `mode`, `capability`, `limit` |
| `kosha_cheapest_model` | Cheapest models meeting requirements | `capability`, `min_context_k`, `provider`, `limit` |
| `kosha_ranked_routes` | Routes ranked by strategy, breaker-open providers last | `strategy` (`cheapest` / `fastest` / `reliable` / `balanced`), same filters as cheapest |
| `kosha_model_detail` | Full card for one model (pricing, capabilities, tool dialect, structured-output modes, status) | `model` |
| `kosha_model_routes` | Every serving-layer route for a model with per-route pricing | `model` |
| `kosha_resolve_alias` | Alias → canonical ID + provider | `alias` |
| `kosha_provider_health` | Auth state, model counts, last discovery error per provider | `provider` |
| `kosha_context_strategy` | Ranked context-management options (continue / cache / compact / switch / batch) with per-turn cost math | `model`, `current_tokens`, `expected_output_tokens`, `expected_remaining_turns` |

`kosha_ranked_routes` is the tool to reach for before routing real traffic: `fastest` uses observed p95 latency, `reliable` folds in circuit-breaker state and timeout / auth-error history, `balanced` blends price, latency, and reliability. The returned order doubles as a failover sequence.

## Example exchange

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"kosha","version":"1.5.0"}}}
→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"kosha_ranked_routes","arguments":{"strategy":"reliable","capability":"tool_use","limit":3}}}
← {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{ \"strategy\": \"reliable\", \"routes\": [ … ] }"}]}}
```
