---
title: 'shipper_create_issue'
description: 'Create a new GitHub issue from a plain-text request.'
---

# shipper_create_issue

Create a new GitHub issue from a plain-text request. Spawns `shipper new <request> --mode headless`, which runs an agent to research the codebase and draft an issue tagged `shipper:new`. Requires a non-empty request.

## When to use

Use this when the user has a plain-language request that should become a researched GitHub issue rather than immediate code changes.

## Behavior hints

- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name    | Type   | Required | Default | Description                                      |
| ------- | ------ | -------- | ------- | ------------------------------------------------ |
| request | string | yes      | -       | Plain-text request for the issue creation agent. |

## Example call

```json
{
  "request": "Add generated MCP reference pages for the docs site"
}
```

## Example result

```text
Created issue: #42 Add generated MCP reference pages for the docs site
URL: https://github.com/owner/repo/issues/42

---
Created a scoped implementation issue.

Session log: /tmp/shipper/session.log
```

## Error modes

- Missing created issue metadata: Unable to recover created issue details from post-run metadata.
- Timed out worker: [timed out] shipper new <request> --mode headless
- Failed worker: [exit <code>] shipper new <request> --mode headless
- Issue recovery failure: gh issue view or issue-list recovery failure: <underlying error message>

## Related tools

- [shipper_groom](./shipper_groom)
- [shipper_advance](./shipper_advance)
