---
title: 'shipper unblock'
description: 'shipper unblock - Check if a blocked issue can proceed'
---

# shipper unblock

Usage: shipper unblock [options] <issue>

Check if a blocked issue can proceed

## Arguments

| Argument | Required | Description  | Choices |
| -------- | -------- | ------------ | ------- |
| <issue>  | yes      | issue number | -       |

## Flags

| Long          | Short | Value   | Default | Description                                       | Choices                        |
| ------------- | ----- | ------- | ------- | ------------------------------------------------- | ------------------------------ |
| --mode        | -     | <mode>  | default | execution mode: headless, interactive, or default | headless, interactive, default |
| --agent       | -     | <name>  | -       | agent to use: claude, codex, or copilot           | claude, codex, copilot         |
| --model       | -     | <model> | -       | model to use for the agent CLI                    | -                              |
| --disable-mcp | -     | -       | -       | disable MCP server loading for this run           | -                              |
| --enable-mcp  | -     | -       | -       | enable MCP server loading for this run            | -                              |

## Examples

Check whether issue 42 can be unblocked.

```sh
shipper unblock 42
```

## Exit Codes

| Code | When                                                                |
| ---- | ------------------------------------------------------------------- |
| 0    | The unblock check completes and writes its result.                  |
| 1    | Validation, preflight, agent execution, or result processing fails. |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
