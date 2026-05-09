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
- shipper init owns committed .shipper/ artifacts in this repository; rerun it and commit the resulting .shipper/ changes when the init drift guard reports drift
- For the files and directories written by shipper init, see [.shipper directory](/reference/shipper-directory/).
- Troubleshooting: [missing or duplicate workflow labels](/troubleshooting/common-errors/#missing-or-duplicate-workflow-labels)
- Troubleshooting: [CLI version drift and version mismatch](/troubleshooting/common-errors/#cli-version-drift-and-version-mismatch)
