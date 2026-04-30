---
title: 'shipper issue list'
description: 'shipper issue list - List shipper-managed issues by pipeline status'
---

# shipper issue list

Usage: shipper issue list [options]

List shipper-managed issues by pipeline status

## Arguments

| Argument | Required | Description | Choices |
| -------- | -------- | ----------- | ------- |
| None     | -        | -           | -       |

## Flags

| Long     | Short | Value  | Default | Description                              | Choices |
| -------- | ----- | ------ | ------- | ---------------------------------------- | ------- |
| --status | -     | <name> | -       | filter to a single status (e.g. planned) | -       |

## Examples

List planned Shipper-managed issues.

```sh
shipper issue list --status planned
```

## Exit Codes

| Code | When                                                            |
| ---- | --------------------------------------------------------------- |
| 0    | Issues are listed successfully, including when no issues match. |
| 1    | Status validation or GitHub issue lookup fails.                 |
