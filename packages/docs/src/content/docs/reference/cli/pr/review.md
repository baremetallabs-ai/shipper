---
title: 'shipper pr review'
description: 'shipper pr review - Review a pull request'
---

# shipper pr review

Usage: shipper pr review [options] [pr]

Review a pull request

## Arguments

| Argument | Required | Description      | Choices |
| -------- | -------- | ---------------- | ------- |
| [pr]     | no       | PR number or URL | -       |

## Flags

| Long          | Short | Value   | Default | Description                                       | Choices                        |
| ------------- | ----- | ------- | ------- | ------------------------------------------------- | ------------------------------ |
| --mode        | -     | <mode>  | default | execution mode: headless, interactive, or default | headless, interactive, default |
| --agent       | -     | <name>  | -       | agent to use: claude, codex, or copilot           | claude, codex, copilot         |
| --model       | -     | <model> | -       | model to use for the agent CLI                    | -                              |
| --disable-mcp | -     | -       | -       | disable MCP server loading for this run           | -                              |
| --enable-mcp  | -     | -       | -       | enable MCP server loading for this run            | -                              |

## Examples

Review pull request 42.

```sh
shipper pr review 42
```

## Exit Codes

| Code | When                                                                  |
| ---- | --------------------------------------------------------------------- |
| 0    | The stage completes successfully or returns a reject verdict.         |
| 1    | Preflight, validation, GitHub, agent, or fail verdict handling fails. |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
