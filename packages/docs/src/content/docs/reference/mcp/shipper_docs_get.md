---
title: 'shipper_docs_get'
description: 'Fetch the full markdown content of a Shipper documentation page by its docs-site path.'
---

# shipper_docs_get

Fetch the full markdown content of a Shipper documentation page by its docs-site path.

## When to use

Use this after search identifies a docs-site path, or when the agent already knows the path of the page it needs.

## Behavior hints

- readOnlyHint: true — The tool only reads state and does not intentionally modify the repository.
- idempotentHint: true — Retrying the same call is expected to be safe once the target state is reached.
- openWorldHint: false — The tool does not reach GitHub or other external systems outside the MCP server.

## Input schema

| Name | Type   | Required | Default | Description |
| ---- | ------ | -------- | ------- | ----------- |
| path | string | yes      | -       | -           |

## Example call

```json
{
  "path": "agents/setup"
}
```

## Example result

```text
# Repository setup for agents

Configure a repository so coding agents can run Shipper reliably.
```

## Error modes

- Unknown path: Documentation page not found for path "<path>". Call shipper_docs_search to find a valid docs path.
- Corpus unavailable or read failure: Shipper documentation corpus is unavailable. Rebuild @baremetallabs-ai/shipper-mcp with the docs snapshot or set SHIPPER_DOCS_PATH to an absolute docs corpus path.

## Related tools

- [shipper_docs_search](./shipper_docs_search)
