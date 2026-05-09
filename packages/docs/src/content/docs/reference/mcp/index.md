---
title: 'MCP'
description: 'Reference for every shipper MCP server tool.'
---

# MCP

Shipper exposes its workflow operations to AI agents via an MCP server. Each tool below has a dedicated reference page covering schema, examples, and error modes. If you need to connect the server first, start with the [MCP setup guide](/guides/mcp-setup/).

## Documentation

- [shipper_docs_search](./shipper_docs_search) — Search the Shipper documentation corpus. Returns matching pages with relevance-ranked snippets so an agent can decide which page(s) to fetch in full.
- [shipper_docs_get](./shipper_docs_get) — Fetch the full markdown content of a Shipper documentation page by its docs-site path.

## Inspection (read-only)

- [shipper_list_issues](./shipper_list_issues) — List shipper-managed issues grouped by workflow stage. Includes blocked and failed sections. Optional status filter restricts output to a single stage (new/groomed/designed/planned/implemented/pr-open/pr-reviewed/ready) or control label (blocked/failed).
- [shipper_get_issue](./shipper_get_issue) — Get detailed information about a specific issue: title, body, labels, state, author, and (if one exists) the linked open PR number.
- [shipper_get_pr_checks](./shipper_get_pr_checks) — Get the CI check status for a pull request: counts and details for failed/pending checks.

## Issue lifecycle

- [shipper_create_issue](./shipper_create_issue) — Create a new GitHub issue from a plain-text request. Spawns `shipper new <request> --mode headless`, which runs an agent to research the codebase and draft an issue tagged `shipper:new`. Requires a non-empty request.
- [shipper_advance](./shipper_advance) — Advance an issue by one workflow stage (shipper next). Dispatches to the appropriate stage command based on the current label. Runs in headless mode — may take several minutes for implementation and PR review stages. Refuses to operate on `shipper:new` issues because grooming requires interactive input.
- [shipper_adopt](./shipper_adopt) — Adopt an existing GitHub issue into the shipper workflow by adding the shipper:new label. Fails if the target is a PR; issues that already have a shipper label return a no-op success.

## Recovery & cleanup

- [shipper_reset](./shipper_reset) — Reset an issue back to an earlier workflow stage without shelling out to the CLI. Requires an explicit target stage. Supports dry-run preview mode and refuses fresh issue locks.
- [shipper_unblock](./shipper_unblock) — Attempt to unblock a blocked issue (shipper:blocked label). Runs the unblock prompt to check if the blocker is resolved. Headless mode.
- [shipper_unlock](./shipper_unlock) — Release an issue lock. With issue: release that issue's lock. With stale=true: sweep all stale locks across the repo. Exactly one of issue or stale must be provided.

## Merge queue

- [shipper_merge](./shipper_merge) — Run the merge queue once for shipper:ready PRs. If an issue number is provided, merges only that PR; otherwise processes all ready PRs. Always runs --once (never polls).

## Experimental: MCP-driven grooming

- [shipper_groom (experimental)](./shipper_groom) — Run grooming on a `shipper:new` issue in headless mode and bridge AskUserQuestion through MCP so the orchestrator answers the worker's clarifying questions via `shipper_answer_question`.
- [shipper_answer_question (experimental)](./shipper_answer_question) — Provide answers to a paused headless worker that called AskUserQuestion. The worker resumes with the supplied answers and continues until it either defers again (returning another awaiting_answer payload) or completes.
