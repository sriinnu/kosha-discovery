# Release runbook

How a kosha-discovery release is cut, with the parts that are easy to forget. Maintainer-only; contributors never need it.

## 1. Prepare

- Bump `version` in `package.json`.
- Bump `version` in `server.json` — it appears **twice**, once at the top level and once under `packages[0]`.
- Bump the `default` version in `action.yml`. The action runs the kosha version it was released with, so a stale default ships the old CLI.
- In `CHANGELOG.md`, add a dated `## [X.Y.Z] — YYYY-MM-DD` heading under `[Unreleased]` so the pending entries fall beneath it.
- `pnpm run check` (lint, build, test) and `pnpm run typecheck`.

## 2. Merge

Open a PR and merge it once CI is green. CI runs the suite on Node 22 and Node 24.

Every commit is signed. Signing uses a hardware key and needs a touch, so make the commits while you are at the machine.

## 3. Tag and stage

```bash
git switch main && git pull --ff-only
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
gh workflow run release-npm.yml --ref vX.Y.Z -f tag=vX.Y.Z -f publish_mcp=false
```

`--ref` matters: the `npm-release` environment only allows `v*` refs, and from `main` the job fails with no logs. The tag must be an annotated, signed tag: the workflow refuses a lightweight one. It checks that the tag matches `package.json`, runs lint / build / test, stages the package on npm with provenance, and creates the GitHub Release. Staging authenticates through npm trusted publishing (OIDC); there is no npm token.

## 4. Approve

The version goes live only after a maintainer approves it with 2FA:

```bash
npm stage list @sriinnu/kosha-discovery
npm stage approve <id>
```

## 5. MCP registry

Once npm is live, publish the MCP server:

```bash
gh workflow run release-npm.yml --ref vX.Y.Z -f tag=vX.Y.Z -f publish_npm=false -f create_github_release=false
```

## 6. Verify

```bash
gh run watch            # the "Manual Release (Tag + npm)" run
npm view @sriinnu/kosha-discovery version
```

Then check that the GitHub Release exists for the tag.

### If a run is red with no steps

A job that sat in the queue and was cancelled after 15 minutes without running a single step was never picked up by a runner — that is GitHub, not the release. Check [githubstatus.com](https://www.githubstatus.com), then cancel and dispatch again; re-running the same queued job tends to stay stuck. Nothing is published until the job actually runs, so dispatching twice is safe.

## Snapshots are not releases

The weekly `snapshot-YYYY-MM-DD` and `snapshot-latest` entries on the Releases page are data, published by the snapshot workflow as pre-releases. They never bump the package version and need no action.
