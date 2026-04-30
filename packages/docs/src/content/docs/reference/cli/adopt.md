---
title: 'shipper adopt'
description: 'shipper adopt - Adopt an existing issue into the shipper workflow'
---

# shipper adopt

Usage: shipper adopt [options] [issue]

Adopt an existing issue into the shipper workflow

## Arguments

| Argument | Required | Description  | Choices |
| -------- | -------- | ------------ | ------- |
| [issue]  | no       | issue number | -       |

## Flags

| Long  | Short | Value | Default | Description                                  | Choices |
| ----- | ----- | ----- | ------- | -------------------------------------------- | ------- |
| --all | -     | -     | false   | adopt all open issues without shipper labels | -       |

## Examples

Adopt one existing issue into the workflow.

```sh
shipper adopt 42
```

Adopt every open issue that does not already have a Shipper workflow label.

```sh
shipper adopt --all
```

## Exit Codes

| Code | When                                                   |
| ---- | ------------------------------------------------------ |
| 0    | The selected issue or issues are labeled successfully. |
| 1    | Validation, issue lookup, or label mutation fails.     |

## Constraints

- --all and an explicit issue argument are mutually exclusive
