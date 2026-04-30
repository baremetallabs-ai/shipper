---
title: 'shipper setup'
description: 'shipper setup - Configure repository settings with an agent'
---

# shipper setup

Usage: shipper setup [options] [words...]

Aliases: shipper agent

Configure repository settings with an agent

## Arguments

| Argument   | Required | Description | Choices |
| ---------- | -------- | ----------- | ------- |
| [words...] | no       | -           | -       |

## Flags

| Long          | Short | Value   | Default | Description                                       | Choices                        |
| ------------- | ----- | ------- | ------- | ------------------------------------------------- | ------------------------------ |
| --mode        | -     | <mode>  | default | execution mode: headless, interactive, or default | headless, interactive, default |
| --agent       | -     | <name>  | -       | agent to use: claude, codex, or copilot           | claude, codex, copilot         |
| --model       | -     | <model> | -       | model to use for the agent CLI                    | -                              |
| --disable-mcp | -     | -       | -       | disable MCP server loading for this run           | -                              |
| --enable-mcp  | -     | -       | -       | enable MCP server loading for this run            | -                              |

## Examples

Run setup with additional instructions for the agent.

```sh
shipper setup "change the default agent to codex"
```

## Exit Codes

| Code | When                                                            |
| ---- | --------------------------------------------------------------- |
| 0    | Setup completes successfully or writes a setup PR.              |
| 1    | Setup validation, agent execution, or setup finalization fails. |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
