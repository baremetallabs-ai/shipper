---
title: 'shipper unlock'
description: 'shipper unlock - Force-release an issue lock or sweep stale locks'
---

# shipper unlock

Usage: shipper unlock [options] [issue]

Force-release an issue lock or sweep stale locks

## Arguments

| Argument | Required | Description  | Choices |
| -------- | -------- | ------------ | ------- |
| [issue]  | no       | issue number | -       |

## Flags

| Long    | Short | Value | Default | Description             | Choices |
| ------- | ----- | ----- | ------- | ----------------------- | ------- |
| --stale | -     | -     | -       | release all stale locks | -       |

## Examples

Release the lock on one issue.

```sh
shipper unlock 42
```

Release all stale issue locks.

```sh
shipper unlock --stale
```

## Exit Codes

| Code | When                                               |
| ---- | -------------------------------------------------- |
| 0    | The selected lock or stale locks are released.     |
| 1    | Validation, issue lookup, or label mutation fails. |

## Constraints

- --stale cannot be used with an issue argument
