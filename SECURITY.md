# Security Policy

## Supported Versions

Only the latest minor release line on npm receives security fixes. Older lines may be patched at maintainer discretion if the fix is trivial and low-risk.

| Version | Supported |
| ------- | --------- |
| 1.2.x   | Yes       |
| < 1.2   | No        |

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
- The MCP server (`kosha-mcp`) and CLI (`kosha-discovery`) entrypoints.
- Any code in this repository under `src/`, `bin/`, or shipped as part of the package.

Out of scope:

- Third-party model providers, their APIs, or their authentication systems.
- Issues that require an attacker with local file-system access where the package is installed.
- Findings against the `update-kosha-snapshot.yml` workflow when running on attacker-controlled forks (workflow does not handle untrusted input).

## Supply Chain

Published npm packages from `1.2.1` onwards include [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — a cryptographic attestation linking the published tarball to the GitHub commit and workflow that built it. Verify with:

```
npm view @sriinnu/kosha-discovery --json | jq '.dist.attestations'
```

All git commits and release tags in this repository are GPG-signed.
