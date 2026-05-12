---
title: 'shipper new'
description: 'shipper new - Create a new issue interactively or from a request'
---

# shipper new

Usage: shipper new [options] [request...]

Create a new issue interactively or from a request

## Arguments

| Argument     | Required | Description                 | Choices |
| ------------ | -------- | --------------------------- | ------- |
| [request...] | no       | your idea for the new issue | -       |

## Flags

| Long          | Short | Value   | Default | Description                                       | Choices                        |
| ------------- | ----- | ------- | ------- | ------------------------------------------------- | ------------------------------ |
| --log-file    | -     | <path>  | -       | write agent output to a specific log file         | -                              |
| --mode        | -     | <mode>  | default | execution mode: headless, interactive, or default | headless, interactive, default |
| --agent       | -     | <name>  | -       | agent to use: claude, codex, or copilot           | claude, codex, copilot         |
| --model       | -     | <model> | -       | model to use for the agent CLI                    | -                              |
| --disable-mcp | -     | -       | -       | disable MCP server loading for this run           | -                              |
| --enable-mcp  | -     | -       | -       | enable MCP server loading for this run            | -                              |

## Examples

Ask Shipper to draft a new issue from a request.

```sh
shipper new Add a CLI flag for stale lock cleanup
```

## Exit Codes

| Code | When                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | Shipper creates the issue from a validated agent draft.                                              |
| 1    | Preflight, draft validation, GitHub issue creation, worktree setup, hooks, or agent execution fails. |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
- Local .shipper/prompts/<agent>/new.md overrides written for the old gh issue create contract must be re-ejected with `shipper eject new` or migrated to the .shipper/output/issue-draft.json protocol.
