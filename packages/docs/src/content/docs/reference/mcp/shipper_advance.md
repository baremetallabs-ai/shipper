---
title: 'shipper_advance'
description: 'Advance an issue by one workflow stage (shipper next).'
---

# shipper_advance

Advance an issue by one workflow stage (shipper next). Dispatches to the appropriate stage command based on the current label. Runs in headless mode — may take several minutes for implementation and PR review stages. Refuses to operate on `shipper:new` issues because grooming requires interactive input.

## When to use

Use this for the normal one-step workflow progression once an issue has moved past intake. Use `shipper_groom` instead for `shipper:new` issues when experimental MCP grooming is enabled.

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
Stage: shipper:planned -> shipper:implemented (accept)
PR: https://github.com/owner/repo/pull/17

---
Implementation complete.

Session log: /tmp/shipper/session.log
```

## Error modes

- Interactive grooming required: Issue #<issue> is at shipper:new. Grooming must be done interactively by a human (it asks clarifying questions and edits the issue body). Ask the user to run `shipper groom <issue>` in their terminal; once the issue moves past `shipper:new`, you can retry this tool.
- Missing stage transition metadata: Unable to recover the stage transition from post-run metadata.
- Timed out worker: [timed out] shipper next <issue> --mode headless
- Failed worker: [exit <code>] shipper next <issue> --mode headless
- GitHub or session lookup failure: GitHub or session lookup failure: <underlying error message>

## Related tools

- [shipper_get_issue](./shipper_get_issue)
- [shipper_get_pr_checks](./shipper_get_pr_checks)
- [shipper_answer_question](./shipper_answer_question)
