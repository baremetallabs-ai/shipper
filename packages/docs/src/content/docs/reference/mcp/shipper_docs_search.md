---
title: 'shipper_docs_search'
description: 'Search the Shipper documentation corpus.'
---

# shipper_docs_search

Search the Shipper documentation corpus. Returns matching pages with relevance-ranked snippets so an agent can decide which page(s) to fetch in full.

## When to use

Use this when an agent needs to discover relevant Shipper docs pages or snippets before fetching a full page.

## Behavior hints

- readOnlyHint: true — The tool only reads state and does not intentionally modify the repository.
- idempotentHint: true — Retrying the same call is expected to be safe once the target state is reached.
- openWorldHint: false — The tool reaches GitHub or other external systems outside the MCP server.

## Input schema

| Name  | Type    | Required | Default | Description |
| ----- | ------- | -------- | ------- | ----------- |
| query | string  | yes      | -       | -           |
| limit | integer | no       | -       | -           |

## Example call

```json
{
  "query": "setup agents",
  "limit": 2
}
```

## Example result

```text
Match 1
path: agents/setup
title: Repository setup for agents
score: 18.00
snippet: Configure a repository so any coding agent can run Shipper reliably...
```

## Error modes

- Corpus unavailable or read failure: Shipper documentation corpus is unavailable. Rebuild @dnsquared/shipper-mcp with the docs snapshot or set SHIPPER_DOCS_PATH to an absolute docs corpus path.

## Related tools

- [shipper_docs_get](./shipper_docs_get)
