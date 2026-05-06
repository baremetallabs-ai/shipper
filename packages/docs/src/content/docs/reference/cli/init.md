---
title: 'shipper init'
description: 'shipper init - Initialize shipper in the current repository'
---

# shipper init

Usage: shipper init [options]

Initialize shipper in the current repository

## Arguments

| Argument | Required | Description | Choices |
| -------- | -------- | ----------- | ------- |
| None     | -        | -           | -       |

## Flags

| Long         | Short | Value  | Default | Description                                           | Choices |
| ------------ | ----- | ------ | ------- | ----------------------------------------------------- | ------- |
| --agent      | -     | <name> | -       | coding agent to use (claude, codex, or copilot)       | -       |
| --autocommit | -     | -      | -       | stage and commit .shipper/ after writing files        | -       |
| --push       | -     | -      | -       | push the commit to the remote (requires --autocommit) | -       |

## Examples

Initialize Shipper in the current repository.

```sh
shipper init
```

## Exit Codes

| Code | When                                                     |
| ---- | -------------------------------------------------------- |
| 0    | Repository configuration files are written successfully. |
| 1    | Validation, setup, git commit, or git push fails.        |

## Constraints

- --push requires --autocommit
- shipper init writes or refreshes .shipper/settings.json cliVersion; rerun it after intentional packages/cli/package.json version bumps in this repository to satisfy the fingerprint guard
