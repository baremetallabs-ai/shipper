---
title: 'shipper pr remediate'
description: 'shipper pr remediate - Remediate a pull request after review feedback'
---

# shipper pr remediate

Usage: shipper pr remediate [options] [pr]

Remediate a pull request after review feedback

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

Remediate review feedback on pull request 42.

```sh
shipper pr remediate 42
```

## Exit Codes

| Code | When                                                                          |
| ---- | ----------------------------------------------------------------------------- |
| 0    | Remediation completes successfully.                                           |
| 1    | Preflight, validation, agent execution, push retry, or result handling fails. |
| 130  | Check polling is interrupted.                                                 |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
