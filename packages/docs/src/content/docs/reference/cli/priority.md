---
title: 'shipper priority'
description: 'shipper priority - Set priority on an issue'
---

# shipper priority

Usage: shipper priority <issue> <level>

Set priority on an issue

## Arguments

| Argument | Required | Description    | Choices           |
| -------- | -------- | -------------- | ----------------- |
| <issue>  | yes      | issue number   | -                 |
| <level>  | yes      | priority level | high, normal, low |

## Flags

| Long | Short | Value | Default | Description | Choices |
| ---- | ----- | ----- | ------- | ----------- | ------- |
| None | -     | -     | -       | -           | -       |

## Examples

Mark issue 42 as high priority.

```sh
shipper priority 42 high
```

Clear explicit priority labels.

```sh
shipper priority 42 normal
```

## Exit Codes

| Code | When                                                                 |
| ---- | -------------------------------------------------------------------- |
| 0    | Priority labels are updated or already match the requested priority. |
| 1    | Validation, issue lookup, or label mutation fails.                   |
