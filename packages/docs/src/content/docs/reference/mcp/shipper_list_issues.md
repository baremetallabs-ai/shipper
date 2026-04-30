---
title: 'shipper_list_issues'
description: 'List shipper-managed issues grouped by workflow stage.'
---

# shipper_list_issues

List shipper-managed issues grouped by workflow stage. Includes blocked and failed sections. Optional status filter restricts output to a single stage (new/groomed/designed/planned/implemented/pr-open/pr-reviewed/ready) or control label (blocked/failed).

## When to use

Use this before changing workflow state when you need a quick inventory of shipper-managed issues, or when an agent needs to choose the next issue by stage or control status.

## Behavior hints

- readOnlyHint: true — The tool only reads state and does not intentionally modify the repository.
- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name   | Type                                                                                             | Required | Default | Description                                    |
| ------ | ------------------------------------------------------------------------------------------------ | -------- | ------- | ---------------------------------------------- |
| status | enum: new, groomed, designed, planned, implemented, pr-open, pr-reviewed, ready, blocked, failed | no       | -       | Workflow stage or control status to filter by. |

## Example call

```json
{}
```

## Example result

```text
Planned (1)
  #42 Generate MCP tool reference pages

Blocked (1)
  #44 Fix release workflow [implemented]
```

## Error modes

- GitHub command failure: GitHub command failure: <underlying error message>

## Related tools

- [shipper_get_issue](./shipper_get_issue)
- [shipper_advance](./shipper_advance)
