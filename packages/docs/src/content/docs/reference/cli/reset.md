---
title: 'shipper reset'
description: 'shipper reset - Reset an issue back to an earlier workflow stage'
---

# shipper reset

Usage: shipper reset [options] <issue>

Reset an issue back to an earlier workflow stage

## Arguments

| Argument | Required | Description  | Choices |
| -------- | -------- | ------------ | ------- |
| <issue>  | yes      | issue number | -       |

## Flags

| Long    | Short | Value   | Default | Description                        | Choices |
| ------- | ----- | ------- | ------- | ---------------------------------- | ------- |
| --force | -f    | -       | -       | skip confirmation prompt           | -       |
| --to    | -     | <stage> | -       | reset to a specific workflow stage | -       |

## Examples

Reset issue 42 without prompting.

```sh
shipper reset 42 --to groomed --force
```

## Exit Codes

| Code | When                                                      |
| ---- | --------------------------------------------------------- |
| 0    | The issue is reset to the selected earlier stage.         |
| 1    | Validation, issue lookup, confirmation, or cleanup fails. |

## Constraints

- Troubleshooting: [failed issues and rollback loops](/troubleshooting/common-errors/#failed-issues-and-rollback-loops)
