---
title: 'shipper_merge'
description: 'Run the merge queue once for shipper:ready PRs.'
---

# shipper_merge

Run the merge queue once for shipper:ready PRs. If an issue number is provided, merges only that PR; otherwise processes all ready PRs. Always runs --once (never polls).

## When to use

Use this when ready PRs should be processed by the merge queue once. Use `shipper_get_pr_checks` first when CI status is uncertain.

## Behavior hints

- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name  | Type    | Required | Default | Description          |
| ----- | ------- | -------- | ------- | -------------------- |
| issue | integer | no       | -       | GitHub issue number. |

## Example call

```json
{}
```

## Example result

```text
[exit 0] shipper merge --once
--- stdout ---
Merged PR #17 for issue #42.
```

## Error modes

- Timed out merge: [timed out] shipper merge --once
- Failed merge: [exit <code>] shipper merge --once
- Spawn failure: Worker command failure: <underlying error message>

## Related tools

- [shipper_get_pr_checks](./shipper_get_pr_checks)
