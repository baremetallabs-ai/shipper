---
name: session-debugger
description: |
  Investigate Claude Code and Codex CLI session transcripts from shipper runs.
  Use for: "investigate session", "debug shipper run", "what went wrong",
  "transcript", "remediation agent", "session failure", "why did the agent fail",
  "check session logs", "find agent sessions for issue".
---

# Session Debugger

Skill for investigating Claude Code and Codex CLI session transcripts produced by `ship --auto` runs. Provides scripts to find, classify, and extract data from JSONL transcript files under `~/.claude/projects/` and `~/.codex/sessions/`.

## Skill Location

This skill is installed at `.claude/skills/session-debugger/` relative to the repo root.

Run scripts from the skill directory:

```bash
.claude/skills/session-debugger/scripts/find-sessions.sh <issue-number>
```

Read reference docs:

```bash
cat .claude/skills/session-debugger/references/transcript-format.md
```

## Quick Reference

| Need                                | Script                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| **Find sessions for an issue**      | `./scripts/find-sessions.sh <issue-number>`                |
| **Classify a session by stage**     | `./scripts/classify-session.sh <jsonl-path>`               |
| **List all tool calls**             | `./scripts/extract-tool-calls.sh <jsonl-path>`             |
| **Find errors (including hidden)**  | `./scripts/extract-errors.sh <jsonl-path>`                 |
| **Drill into a specific tool call** | `./scripts/show-tool-result.sh <jsonl-path> <call-number>` |
| **Get agent's final message**       | `./scripts/extract-final-message.sh <jsonl-path>`          |
| **Extract verdict/labels/comments** | `./scripts/extract-verdict.sh <jsonl-path>`                |

Notes:

- `find-sessions.sh` returns a mixed timeline with `[claude]` / `[codex]` prefixes
- `classify-session.sh` prints `Agent: claude` or `Agent: codex`

## Prerequisites

- `jq` must be installed (`brew install jq` on macOS)
- Session transcripts must exist under `~/.claude/projects/` or `~/.codex/sessions/`

## Reference Docs

- [Transcript Format](references/transcript-format.md) — Claude Code and Codex CLI JSONL schema, directory layout, matching sessions to shipper stages

## Task Workflows

### Investigate a specific stage run

1. `./scripts/find-sessions.sh <issue>` — list all session files for the issue across Claude and Codex, using the `[claude]` / `[codex]` prefix to identify the agent
2. Pick the session matching the timeframe or stage of interest
3. `./scripts/classify-session.sh <file>` — confirm the agent type and stage (implement, pr-open, pr-review, pr-remediate)
4. `./scripts/extract-tool-calls.sh <file>` — get numbered list of tool calls with error status
5. Read the JSONL file directly to inspect interesting spans (e.g., around ERROR entries)

### Find all sessions for an issue

1. `./scripts/find-sessions.sh <issue>` — get all session files from both transcript stores
2. For each file, run `./scripts/classify-session.sh <file>` to identify the agent and stage
3. Build a timeline of what ran and when

### Extract what went wrong

1. `./scripts/find-sessions.sh <issue>` — locate the failing session
2. `./scripts/extract-errors.sh <file>` — find all errors (`is_error` for Claude, content-level matching for Codex)
3. `./scripts/show-tool-result.sh <file> <N>` — drill into specific error tool calls for full context
4. `./scripts/extract-final-message.sh <file>` — see what the agent concluded
5. `./scripts/extract-verdict.sh <file>` — check if a remediation agent left a verdict (READY/RETRY/NEEDS UPSTREAM)

### Quick error triage

1. `./scripts/find-sessions.sh <issue>` — find sessions
2. `./scripts/extract-errors.sh <file>` — scan for errors in one pass
3. If content errors found, use `./scripts/show-tool-result.sh <file> <N>` to see full output
4. `./scripts/extract-final-message.sh <file>` — check if the agent acknowledged the failure
