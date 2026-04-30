---
title: 'shipper_reset'
description: 'Reset an issue back to an earlier workflow stage without shelling out to the CLI.'
---

# shipper_reset

Reset an issue back to an earlier workflow stage without shelling out to the CLI. Requires an explicit target stage. Supports dry-run preview mode and refuses fresh issue locks.

## When to use

Use this for explicit recovery when an issue must move backward to an earlier workflow stage. Prefer dry-run first so the agent can inspect cleanup actions before mutating state.

## Behavior hints

- destructiveHint: true — The tool can remove or rewrite workflow artifacts and should be used carefully.
- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name    | Type                                               | Required | Default | Description                                              |
| ------- | -------------------------------------------------- | -------- | ------- | -------------------------------------------------------- |
| issue   | integer                                            | yes      | -       | GitHub issue number.                                     |
| target  | enum: new, groomed, designed, planned, implemented | yes      | -       | Earlier workflow stage to reset the issue to.            |
| dry_run | boolean                                            | no       | -       | When true, preview reset cleanup without making changes. |

## Example call

```json
{
  "issue": 42,
  "target": "groomed",
  "dry_run": true
}
```

## Example result

```text
Reset preview for issue #42:
Target: shipper:groomed
Labels to remove: shipper:planned
Label to add: shipper:groomed
Dry run only; no changes made.
```

## Error modes

- Pull request target: #<issue> is a pull request, not an issue.
- Closed issue: Issue #<issue> is closed. Reset only works on open issues.
- Active lock: Issue #<issue> is locked by another shipper instance. Release the lock with shipper_unlock before retrying.
- Already at target: Error: Issue #<issue> is already at shipper:<target>. Reset only works backward.
- Target ahead of current stage: Error: shipper:<target> is ahead of the current stage shipper:<stage>. Reset only works backward.
- Partial reset failure: failed: <operation> (<reason>)
- Scan, execution, or GitHub failure: Scan/execute/GitHub failure: <underlying error message>

## Related tools

- [shipper_get_issue](./shipper_get_issue)
- [shipper_unlock](./shipper_unlock)
