---
title: 'shipper ship'
description: 'shipper ship - Run the full workflow end-to-end'
---

# shipper ship

Usage: shipper ship [options] [issue]

Run the full workflow end-to-end

## Arguments

| Argument | Required | Description  | Choices |
| -------- | -------- | ------------ | ------- |
| [issue]  | no       | issue number | -       |

## Flags

| Long          | Short | Value   | Default | Description                                       | Choices                        |
| ------------- | ----- | ------- | ------- | ------------------------------------------------- | ------------------------------ |
| --merge       | -     | -       | false   | auto-merge the PR after reaching shipper:ready    | -                              |
| --auto        | -     | -       | false   | run autonomous continuous shipping loop           | -                              |
| --parallel    | -     | <n>     | -       | number of parallel slots (requires --auto)        | -                              |
| --mode        | -     | <mode>  | default | execution mode: headless, interactive, or default | headless, interactive, default |
| --agent       | -     | <name>  | -       | agent to use: claude, codex, or copilot           | claude, codex, copilot         |
| --model       | -     | <model> | -       | model to use for the agent CLI                    | -                              |
| --disable-mcp | -     | -       | -       | disable MCP server loading for this run           | -                              |
| --enable-mcp  | -     | -       | -       | enable MCP server loading for this run            | -                              |

## Examples

Run issue 42 through the workflow and merge it.

```sh
shipper ship 42 --merge
```

Run the autonomous shipping loop with three parallel slots.

```sh
shipper ship --auto --parallel 3
```

## Exit Codes

| Code | When                                                                         |
| ---- | ---------------------------------------------------------------------------- |
| 0    | The issue or auto run completes without a terminal failure.                  |
| 1    | Preflight, validation, stage execution, merge, or auto-ship execution fails. |
| 75   | A single-issue ship run pauses because the pause sentinel is present.        |
| 76   | A single-issue ship run encounters a retriable failure.                      |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
- --auto and an explicit issue argument are mutually exclusive
- An issue argument is required unless --auto is used
- --auto and --mode are mutually exclusive
- --parallel <n> requires --auto
- --parallel <n> must be a positive integer
