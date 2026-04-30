---
title: 'shipper_adopt'
description: 'Adopt an existing GitHub issue into the shipper workflow by adding the shipper:new label.'
---

# shipper_adopt

Adopt an existing GitHub issue into the shipper workflow by adding the shipper:new label. Fails if the target is a PR; issues that already have a shipper label return a no-op success.

## When to use

Use this when an existing open GitHub issue should enter the shipper workflow at `shipper:new` instead of creating a new issue.

## Behavior hints

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
Issue #42 adopted into shipper workflow.
```

## Error modes

- Pull request target: #<issue> is a pull request, not an issue.
- Issue lookup or label mutation failure: Issue lookup/label mutation failure: <underlying error message>

## Related tools

- [shipper_get_issue](./shipper_get_issue)
- [shipper_groom](./shipper_groom)
