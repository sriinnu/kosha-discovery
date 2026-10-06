# Troubleshooting

Start with `kosha doctor`. It reports deprecations, circuit-breaker state and the last discovery error per provider, and most of what follows is a longer explanation of something it already told you.

## A provider shows `authenticated: false` but I set its key

The key was found and the provider rejected it, or the call failed. From 1.7.0, kosha then lists that provider from the public catalog instead of dropping it, and reports it as unauthenticated because that is what it effectively is. The original error is kept: `kosha doctor`, or `discoveryErrors()` in the library.

Common causes:

- **The key expired or was revoked.** Nothing to do on kosha's side.
- **Regional pairs.** `moonshot` / `moonshot-cn`, `minimax` / `minimax-cn`, `alibaba` / `alibaba-cn`, `siliconflow` / `siliconflow-cn` and `stepfun` / `stepfun-cn` are separate hosts with separate price sheets, and the China-side provider falls back to the international env var name. A key issued for one region is tried against both and is refused by the other. That is expected: one of the pair shows as unauthenticated.
- **The variable is set but empty.** An empty value counts as absent, so the provider takes the keyless path without an error.

Exact variable names per provider are on the [Credentials](Credentials) page.

## A provider is missing entirely

Before 1.7.0, a rejected key with no cache behind it removed the provider's whole catalog. Upgrade. If it is still missing, the keyless path returned nothing either — `kosha doctor` has the error.

## An alias resolves to last generation's model

Bare aliases (`opus`, `sonnet`, `grok`, `gemini-flash`) are meant to track the newest generally-available model, and the table behind them is written by hand. Check it against a snapshot:

```bash
curl -sLO https://github.com/sriinnu/kosha-discovery/releases/download/snapshot-latest/kosha-latest.json
pnpm aliases:check kosha-latest.json
```

It reports aliases whose target no provider lists any more, and bare aliases with a newer sibling. Until a release catches up, override the alias yourself — see [Configuration](Configuration).

Two aliases are held back on purpose: `gemini-pro` stays on the newest GA Pro model rather than a preview, and `gemini-embed` stays on `gemini-embedding-001` because a newer embedding model is a different vector space.

## `kosha routes` shows several Bedrock rows for one model

Those are cross-region inference profiles: `us.`, `eu.`, `jp.`, `au.`, `global.` in front of the same model, each with its own price. They are distinct routes, so they are listed separately.

## Bedrock or Vertex lists models my account cannot call

Without the AWS SDK / CLI or gcloud, the listing comes from the public catalog: everything the platform serves, not what is enabled in your region or project. Install `@aws-sdk/client-bedrock` or the AWS CLI, or authenticate gcloud, to get the account-accurate list.

## A new model is not showing up

Results are cached for 24 hours under `~/.kosha/cache/`. `kosha refresh` forces a new fetch; `kosha refresh --provider <id>` does one provider.

## `tool_choice: "required"` did not force a tool call through the proxy

Some Claude models reject forced tool use outright — Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5. For those the proxy degrades the request to `auto` and adds an instruction naming the tool, and says so in its translation notes, rather than forwarding a request that would return a 400.
