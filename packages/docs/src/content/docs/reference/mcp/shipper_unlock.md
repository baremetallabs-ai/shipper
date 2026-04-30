---
title: 'shipper_unlock'
description: 'Release an issue lock.'
---

# shipper_unlock

Release an issue lock. With issue: release that issue's lock. With stale=true: sweep all stale locks across the repo. Exactly one of issue or stale must be provided.

## When to use

Use this when a stale or manually held shipper lock is preventing workflow progress. Choose either one issue or a stale-lock sweep.

## Behavior hints

- idempotentHint: true — Retrying the same call is expected to be safe once the target state is reached.
- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name  | Type    | Required | Default | Description                                                    |
| ----- | ------- | -------- | ------- | -------------------------------------------------------------- |
| issue | integer | no       | -       | GitHub issue number.                                           |
| stale | boolean | no       | -       | When true, release every stale shipper lock in the repository. |

## Example call

```json
{
  "issue": 42
}
```

## Example result

```text
Released lock on #42.
```

## Error modes

- Conflicting arguments: Provide either `issue` or `stale`, not both.
- Missing target: Provide either `issue` or `stale: true`.
- Lock release or list failure: Lock release/list failure: <underlying error message>

## Related tools

- [shipper_reset](./shipper_reset)
- [shipper_unblock](./shipper_unblock)
