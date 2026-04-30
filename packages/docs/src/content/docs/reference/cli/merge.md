---
title: 'shipper merge'
description: 'shipper merge - Run the merge queue for PRs labeled shipper:ready'
---

# shipper merge

Usage: shipper merge [options] [number]

Run the merge queue for PRs labeled shipper:ready

## Arguments

| Argument | Required | Description                 | Choices |
| -------- | -------- | --------------------------- | ------- |
| [number] | no       | PR or issue number to merge | -       |

## Flags

| Long       | Short | Value        | Default | Description                             | Choices |
| ---------- | ----- | ------------ | ------- | --------------------------------------- | ------- |
| --interval | -     | <seconds>    | 60      | polling interval in seconds             | -       |
| --once     | -     | -            | false   | process the queue once and exit         | -       |
| --dry-run  | -     | -            | false   | print actions without executing         | -       |
| --repo     | -     | <owner/repo> | -       | repository (default: inferred from cwd) | -       |

## Examples

Process the merge queue once.

```sh
shipper merge --once
```

Preview merging a specific PR or issue.

```sh
shipper merge 42 --dry-run
```

## Exit Codes

| Code | When                                                                       |
| ---- | -------------------------------------------------------------------------- |
| 0    | The merge queue completes, is empty, or the dry run completes.             |
| 1    | Validation, lock acquisition, GitHub lookup, CI, or merge execution fails. |

## Constraints

- --interval <seconds> must be a positive integer
