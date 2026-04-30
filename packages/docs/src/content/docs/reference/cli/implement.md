---
title: 'shipper implement'
description: 'shipper implement - Implement an issue in a worktree'
---

# shipper implement

Usage: shipper implement [options] [issue]

Implement an issue in a worktree

## Arguments

| Argument | Required | Description         | Choices |
| -------- | -------- | ------------------- | ------- |
| [issue]  | no       | issue number or URL | -       |

## Flags

| Long          | Short | Value   | Default | Description                                       | Choices                        |
| ------------- | ----- | ------- | ------- | ------------------------------------------------- | ------------------------------ |
| --mode        | -     | <mode>  | default | execution mode: headless, interactive, or default | headless, interactive, default |
| --agent       | -     | <name>  | -       | agent to use: claude, codex, or copilot           | claude, codex, copilot         |
| --model       | -     | <model> | -       | model to use for the agent CLI                    | -                              |
| --disable-mcp | -     | -       | -       | disable MCP server loading for this run           | -                              |
| --enable-mcp  | -     | -       | -       | enable MCP server loading for this run            | -                              |

## Examples

Implement issue 42 in a worktree.

```sh
shipper implement 42
```

## Exit Codes

| Code | When                                                                  |
| ---- | --------------------------------------------------------------------- |
| 0    | The stage completes successfully or returns a reject verdict.         |
| 1    | Preflight, validation, GitHub, agent, or fail verdict handling fails. |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
