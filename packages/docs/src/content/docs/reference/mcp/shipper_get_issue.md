---
title: 'shipper_get_issue'
description: 'Get detailed information about a specific issue: title, body, labels, state, author, and (if one exists) the linked open PR number.'
---

# shipper_get_issue

Get detailed information about a specific issue: title, body, labels, state, author, and (if one exists) the linked open PR number.

## When to use

Use this when an agent needs the issue body, labels, state, and linked PR before deciding whether to advance, reset, inspect checks, or answer a paused worker.

## Behavior hints

- readOnlyHint: true — The tool only reads state and does not intentionally modify the repository.
- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name  | Type    | Required | Default | Description          |
| ----- | ------- | -------- | ------- | -------------------- |
| issue | integer | yes      | -       | GitHub issue number. |

## Example call

```json
{
  "issue": 42
}
```

## Example result

```text
<issue number="42" state="OPEN">
<title>Generate MCP tool reference pages</title>
<labels>
  <label>shipper:planned</label>
</labels>
<body>Generate reference pages from MCP tool metadata.</body>
</issue>

<linked-pr number="17"/>
```

## Error modes

- GitHub command failure: Command failed: gh <args>

## Related tools

- [shipper_get_pr_checks](./shipper_get_pr_checks)
- [shipper_advance](./shipper_advance)
- [shipper_reset](./shipper_reset)
