# Security Policy

## Supported Versions

Only the latest minor release line on npm receives security fixes. Older lines may be patched at maintainer discretion if the fix is trivial and low-risk.

| Version | Supported |
| ------- | --------- |
| 1.8.x   | Yes       |
| < 1.8   | No        |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security reports.

Report privately via GitHub's [private vulnerability reporting](https://github.com/sriinnu/kosha-discovery/security/advisories/new), or email `hello@srinivas.dev` with subject `kosha-discovery security`.

Include:

- A description of the issue and the affected code path (file + function if possible).
- Steps to reproduce, or a minimal proof of concept.
- The version of `@sriinnu/kosha-discovery` you tested against.
- Your assessment of severity and impact.

I'll acknowledge receipt within 72 hours, share an initial assessment within 7 days, and aim to ship a fix within 30 days for high/critical issues. Coordinated disclosure timelines are negotiable for non-trivial fixes.

## Scope

In scope:

- The published `@sriinnu/kosha-discovery` package on npm.
- The MCP server (`kosha-mcp`) and CLI (`kosha`) entrypoints.
- The GitHub Action (`action.yml`) and the release workflow.
- Any code in this repository under `src/` or shipped as part of the package.

Out of scope:

- Third-party model providers, their APIs, or their authentication systems.
- Issues that require an attacker with local file-system access where the package is installed.
- Findings against the `update-kosha-snapshot.yml` workflow when running on attacker-controlled forks (workflow does not handle untrusted input).

## Supply Chain

kosha reads provider API keys from the environment. A compromised kosha release
would hold exactly the credentials a stealer wants, so the release path is built
on the assumption that a maintainer token will one day be stolen, as happened
to LiteLLM on October 21, 2026 (`litellm==1.107.0`).

**What a release has to pass.**

- Release tags (`v*`) are signed with a hardware key (FIDO2 ECDSA-SK over SSH).
  A repository ruleset requires signed commits on those tags and forbids
  deleting them; version tags (`v*.*`) cannot be moved.
- The release workflow verifies the tag signature against
  `.github/allowed_signers` read from `main`, checks every key in that file
  against fingerprints pinned in the workflow, and requires the tagged commit
  to be on `main`'s history. `main` only accepts signed commits.
- The publish job runs in the `npm-release` environment, which only admits
  `v*` tags and waits for a reviewer.
- npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers)
  (OIDC) bound to this repository, workflow file and environment. There is no
  long-lived npm token in CI or on a maintainer machine.
- Every published version carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
  linking the tarball to the commit and workflow that built it. Verify with:

  ```
  npm view @sriinnu/kosha-discovery --json | jq '.dist.attestations'
  ```

**What kosha does not do.**

- The GitHub Action runs the kosha version it was released with, not `latest`,
  and installs it with `--ignore-scripts`. Pin the action to a commit SHA.
- Dependencies (two at runtime) install with a frozen lockfile, lifecycle
  scripts off, and a seven-day minimum release age (`pnpm-workspace.yaml`).
- Provider keys are read at discovery time and are not written to the cache or
  the pricing manifest. Every external payload, cache read included, goes
  through the scan in `src/security.ts` (see `docs/security.md`).
