# Terminal Project

## Chitragupta Integration (MANDATORY)

Chitragupta is your memory and continuity layer. **Use it proactively in every session.**

## Permanent Rules
- Always spawn agents for substantial tasks when the work is parallelizable.
- Always run Chitragupta co-orchestrator checks in each substantial cycle.
- Always use Chitragupta MCP agentic delegation tools for substantial orchestration work.

### Session Start
- Call `chitragupta_memory_search` with the current task to load relevant context from past sessions.
- Call `chitragupta_session_list` to see recent sessions for this project.

### During Work
- Before making architectural decisions, call `chitragupta_memory_search` to check what was decided before.
- After completing significant work, call `akasha_deposit` with type "solution" to record the approach.
- When discovering recurring patterns, call `akasha_deposit` with type "pattern".
- Use `chitragupta_recall` for unified search across all memory layers when broader context is needed.

### Context Limits
- When approaching context limits, call `chitragupta_handover` to preserve work state.
- On session resume, call `chitragupta_session_show` with the last session ID to restore context.

### General Rule
When in doubt, search chitragupta first. Past sessions hold decisions, patterns, and solutions that prevent repeated work.
- use worktress outside of the repo workspace - multiple worktrees for agents. (distilled code instead of full copy of the codebase - as long as you know what to do and how to do, you can have a copy of the the agents.md or claude.md)

# Chitragupta MCP

## Session Start
- At the START of every session, call `chitragupta_memory_search` with the current task
  to load relevant context from past sessions.
- Call `chitragupta_session_list` to see recent sessions for this project.

## During Work
- When making architectural decisions, search past sessions first —
  call `chitragupta_memory_search` to check what was decided before.
- After completing significant work, call `akasha_deposit` with type "solution"
  to record the approach for future sessions.
- When you discover a recurring pattern, call `akasha_deposit` with type "pattern".

## Coding Agent
- For substantial coding tasks, use the `coding_agent` tool — it runs a full
  autonomous pipeline: Plan → Branch → Execute → Validate → Review → Commit.
- Call it with `{ "task": "your task", "mode": "full" }` for end-to-end execution.
- Use `"mode": "plan-only"` to plan without executing.
- The coding agent creates git branches, runs tests, and self-reviews its work.

## Context Limits
- When approaching context limits, call `chitragupta_handover` to preserve
  work state (files modified, decisions made, errors encountered).
- On session resume, call `chitragupta_session_show` with the last session ID
  to restore context.

## Key Tools
- `coding_agent` — delegate coding tasks (Plan → Branch → Code → Test → Review → Commit)
- `chitragupta_memory_search` — search project memory (GraphRAG-backed)
- `chitragupta_session_list` — list recent sessions
- `chitragupta_session_show` — show session by ID
- `chitragupta_handover` — work-state handover for context continuity
- `chitragupta_prompt` — delegate a task to Chitragupta's agent
- `akasha_traces` — query collective knowledge traces
- `akasha_deposit` — record solutions, patterns, warnings
- `sabha_deliberate` — multi-agent deliberation on proposals
- `vasana_tendencies` — learned behavioral patterns
- `health_status` — system health (Triguna)
- `atman_report` — full self-report
