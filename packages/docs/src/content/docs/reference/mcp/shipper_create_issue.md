---
title: 'shipper_create_issue'
description: 'Create a new GitHub issue from a plain-text request.'
---

# shipper_create_issue

Create a new GitHub issue from a plain-text request. Spawns `shipper new <request> --mode headless`; the agent drafts under `.shipper/output/`, then Shipper validates, creates the issue, applies `shipper:new`, and records the created issue identity. Requires a non-empty request.

## When to use

Use this when the user has a plain-language request that should become a researched GitHub issue rather than immediate code changes. The headless agent writes a draft under `.shipper/output/`, Shipper validates the draft, creates the GitHub issue, applies `shipper:new`, and records the final `created_issue` identity. The transcript is used only for the final-message wrap-up.

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

- Timed out worker: [timed out] shipper new <request> --mode headless
- Failed worker: [exit <code>] shipper new <request> --mode headless

## Related tools

- [shipper_groom](./shipper_groom)
- [shipper_advance](./shipper_advance)
