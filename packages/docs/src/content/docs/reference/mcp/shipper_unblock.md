---
title: 'shipper_unblock'
description: 'Attempt to unblock a blocked issue (shipper:blocked label).'
---

# shipper_unblock

Attempt to unblock a blocked issue (shipper:blocked label). Runs the unblock prompt to check if the blocker is resolved. Headless mode.

## When to use

Use this when an issue is marked `shipper:blocked` and an agent needs to determine whether the blocker has cleared and the workflow can continue.

## Behavior hints

- idempotentHint: true — Retrying the same call is expected to be safe once the target state is reached.
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
Verdict: unblocked
Reason: The dependency has merged and the blocked work can continue.

---
Blocker resolved.

Session log: /tmp/shipper/session.log
```

## Error modes

- Missing unblock verdict: Unable to recover the unblock verdict from post-run metadata.
- Timed out worker: [timed out] shipper unblock <issue> --mode headless
- Failed worker: [exit <code>] shipper unblock <issue> --mode headless
- GitHub, session, or result-file failure: GitHub, session, or result-file failure: <underlying error message>

## Related tools

- [shipper_get_issue](./shipper_get_issue)
- [shipper_advance](./shipper_advance)
