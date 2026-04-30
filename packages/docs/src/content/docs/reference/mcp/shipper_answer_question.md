---
title: 'shipper_answer_question'
description: 'Provide answers to a paused headless worker that called AskUserQuestion.'
experimental: true
flag: 'SHIPPER_EXPERIMENTAL_MCP_GROOMING'
---

# shipper_answer_question

Provide answers to a paused headless worker that called AskUserQuestion. The worker resumes with the supplied answers and continues until it either defers again (returning another awaiting_answer payload) or completes. Experimental — only registered when `isMcpGroomingEnabled()` returns true. Set `SHIPPER_EXPERIMENTAL_MCP_GROOMING` to enable.

## When to use

Use this only after `shipper_groom` or `shipper_advance` returns an awaiting-answer session id. The answers map should use the exact question text returned by the paused worker.

## Behavior hints

- openWorldHint: true — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name       | Type   | Required | Default | Description                                                               |
| ---------- | ------ | -------- | ------- | ------------------------------------------------------------------------- |
| session_id | string | yes      | -       | Paused shipper worker session id returned by an awaiting_answer response. |
| answers    | object | yes      | -       | Map from question text to the answer to send back to the paused worker.   |

## Example call

```json
{
  "session_id": "sess-abc123",
  "answers": {
    "Which behavior should the implementation preserve?": "Keep the current MCP response shape."
  }
}
```

## Example result

```text
Stage: shipper:new -> shipper:groomed (accept)

---
Grooming complete.

Session log: /tmp/shipper/session.log
```

## Error modes

- Missing pending session: No pending shipper session with id "<session_id>". The worker may have already completed or the MCP server may have restarted.
- Completed before answer: Cannot submit an answer: shipper child already completed.
- Unavailable stdin: shipper child stdin is unavailable; cannot submit answer.
- No more events: Shipper child has already completed; no more events.
- Missing stage transition metadata: Unable to recover the stage transition from post-run metadata.
- Worker command failure: spawn shipper ENOENT

## Related tools

- [shipper_groom](./shipper_groom)
- [shipper_advance](./shipper_advance)
