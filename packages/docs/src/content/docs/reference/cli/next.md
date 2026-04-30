---
title: 'shipper next'
description: 'shipper next - Advance an issue to the next workflow step'
---

# shipper next

Usage: shipper next [options] <ref>

Advance an issue to the next workflow step

## Arguments

| Argument | Required | Description            | Choices |
| -------- | -------- | ---------------------- | ------- |
| <ref>    | yes      | issue or PR number/URL | -       |

## Flags

| Long          | Short | Value   | Default | Description                                       | Choices                        |
| ------------- | ----- | ------- | ------- | ------------------------------------------------- | ------------------------------ |
| --mode        | -     | <mode>  | default | execution mode: headless, interactive, or default | headless, interactive, default |
| --agent       | -     | <name>  | -       | agent to use: claude, codex, or copilot           | claude, codex, copilot         |
| --model       | -     | <model> | -       | model to use for the agent CLI                    | -                              |
| --disable-mcp | -     | -       | -       | disable MCP server loading for this run           | -                              |
| --enable-mcp  | -     | -       | -       | enable MCP server loading for this run            | -                              |

## Examples

Advance issue 42 to its next workflow stage.

```sh
shipper next 42
```

## Exit Codes

| Code | When                                                                         |
| ---- | ---------------------------------------------------------------------------- |
| 0    | The next stage succeeds or returns a reject verdict.                         |
| 1    | Preflight, label validation, stage dispatch, or fail verdict handling fails. |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
