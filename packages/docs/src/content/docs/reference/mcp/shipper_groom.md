---
title: 'shipper_groom'
description: "Run grooming on a `shipper:new` issue in headless mode and bridge AskUserQuestion through MCP so the orchestrator answers the worker's clarifying questions via `shipper_answer_question`."
experimental: true
flag: 'SHIPPER_EXPERIMENTAL_MCP_GROOMING'
---

# shipper_groom

Run grooming on a `shipper:new` issue in headless mode and bridge AskUserQuestion through MCP so the orchestrator answers the worker's clarifying questions via `shipper_answer_question`. Experimental — only registered when `isMcpGroomingEnabled()` returns true. See [Experimental feature flags](/reference/environment-variables/#experimental-feature-flags) for `SHIPPER_EXPERIMENTAL_MCP_GROOMING` enablement.

## When to use

Use this only for `shipper:new` issues when MCP-driven grooming is enabled and the orchestrator is prepared to answer worker questions with `shipper_answer_question`. Each awaiting_answer result contains exactly one question batch; if the worker has more pending batches, the next one is returned by `shipper_answer_question` after the current batch is answered.

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
Status: awaiting_answer
Session: sess-abc123

The headless worker called AskUserQuestion and is paused awaiting answers from the orchestrator.
Reply with `shipper_answer_question` providing { session_id, answers } where answers is a map
of question text -> your answer (free text).

Questions (JSON):
[
  {
    "question": "Which behavior should the implementation preserve?"
  }
]
```

## Error modes

- Wrong issue stage: shipper_groom only operates on issues at shipper:new. Issue #<issue> has labels: <labels>.
- Missing stage transition metadata: Unable to recover the stage transition from post-run metadata.
- Timed out worker: [timed out] shipper groom <issue> --mode headless
- Failed worker: [exit <code>] shipper groom <issue> --mode headless
- GitHub or session lookup failure: Command failed: gh <args>

## Related tools

- [shipper_answer_question](./shipper_answer_question)
- [shipper_advance](./shipper_advance)
