# Agent Instructions

These rules are mandatory for all code changes in this project.

# How codex must perform
- permanent rule: always spawn agents for substantial tasks when work is parallelizable.
- use chitragupta mcp - as a good agentic assistant.
- permanent rule: use Chitragupta MCP agentic delegation tools in each substantial cycle.
- use worktress outside of the repo workspace - multiple worktrees for agents. (distilled code instead of full copy of the codebase - as long as you know what to do and how to do, you can have a copy of the the agents.md or claude.md)
- permanent rule: always run Chitragupta co-orchestrator checks in each substantial cycle; report failures or regressions immediately.
- branch workflow: before creating a new branch, push current work via PR, merge to `main`, then create the next branch from latest `origin/main`.

## Distilled Context Orchestration Policy (Cost + Leakage)

1. Deterministic first: each agent gets explicit task verb, owned files, and expected output format.
2. Minimal task capsules only: send the smallest context needed (target snippets/interfaces), never broad repo dumps.
3. Close agents fast: terminate agents immediately on completion or stall; relaunch with narrower scope if needed.
4. Redact secrets always: never place secret values (`.env`, keys, tokens, credentials) in capsules, prompts, or logs.
5. Scope by owned files: agents edit only assigned files; avoid overlap unless there is an explicit handoff owner.

## Engineering Guardrails

1. No source file may exceed `450` lines of code.
2. Add JSDoc to all exported functions, classes, React components, and hooks.
3. Add inline comments where logic is non-obvious; avoid redundant comments.
4. UI/UX quality must be spot on:
   - clear information hierarchy and spacing
   - responsive behavior on desktop and mobile
   - accessible semantics, focus states, and keyboard usability
   - consistent visual language across screens
5. Typescript - strict typing where possible.
