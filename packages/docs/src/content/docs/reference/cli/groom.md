---
title: 'shipper groom'
description: 'shipper groom - Groom an existing issue'
---

# shipper groom

Usage: shipper groom [options] [issue]

Groom an existing issue

## Arguments

| Argument | Required | Description         | Choices |
| -------- | -------- | ------------------- | ------- |
| [issue]  | no       | issue number or URL | -       |

## Flags

| Long          | Short | Value   | Default | Description                                       | Choices                        |
| ------------- | ----- | ------- | ------- | ------------------------------------------------- | ------------------------------ |
| --auto        | -     | -       | false   | groom all eligible shipper:new issues in sequence | -                              |
| --mode        | -     | <mode>  | default | execution mode: headless, interactive, or default | headless, interactive, default |
| --agent       | -     | <name>  | -       | agent to use: claude, codex, or copilot           | claude, codex, copilot         |
| --model       | -     | <model> | -       | model to use for the agent CLI                    | -                              |
| --disable-mcp | -     | -       | -       | disable MCP server loading for this run           | -                              |
| --enable-mcp  | -     | -       | -       | enable MCP server loading for this run            | -                              |

## Examples

Groom one issue by number.

```sh
shipper groom 42
```

Groom all eligible new issues in sequence.

```sh
shipper groom --auto
```

## Exit Codes

| Code | When                                                                  |
| ---- | --------------------------------------------------------------------- |
| 0    | The stage completes successfully or returns a reject verdict.         |
| 1    | Preflight, validation, GitHub, agent, or fail verdict handling fails. |

## Constraints

- --disable-mcp and --enable-mcp are mutually exclusive
- --auto and an explicit issue argument are mutually exclusive
