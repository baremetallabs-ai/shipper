---
title: 'shipper_get_pr_checks'
description: 'Get the CI check status for a pull request: counts and details for failed/pending checks.'
---

# shipper_get_pr_checks

Get the CI check status for a pull request: counts and details for failed/pending checks.

## When to use

Use this after a PR exists and before merge or remediation decisions, especially when an agent needs the failing or pending check names.

## Behavior hints

- readOnlyHint: true — The tool only reads state and does not intentionally modify the repository.
- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name | Type    | Required | Default | Description                 |
| ---- | ------- | -------- | ------- | --------------------------- |
| pr   | integer | yes      | -       | GitHub pull request number. |

## Example call

```json
{
  "pr": 17
}
```

## Example result

```text
Checks for owner/repo#17: 2 passed, 1 pending, 0 failed (total: 3)

Pending:
  - check
```

## Error modes

- GitHub command failure: Command failed: gh <args>

## Related tools

- [shipper_merge](./shipper_merge)
