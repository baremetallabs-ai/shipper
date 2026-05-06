# @baremetallabs-ai/shipper-core

`@baremetallabs-ai/shipper-core` is Shipper's internal companion library for workspace packages. It
supports the CLI, desktop app, and MCP server; it is not intended to be a general-purpose external
SDK.

External users should use the stable Shipper workflows through
[`@baremetallabs-ai/shipper-cli`](https://www.npmjs.com/package/@baremetallabs-ai/shipper-cli) or
the supported desktop app. Direct core imports are for Shipper workspace consumers that move in
lockstep with this repository.

## What Core Provides

Core contains the shared workflow engine and support utilities used by the Shipper entry points:

- Workflow labels, priority labels, state transitions, and lock handling.
- GitHub helpers built around the `gh` CLI, including typed parsing for structured `gh --json`
  payloads.
- Prompt resolution, prompt execution, stage scaffolding, output protocol parsing, and verdict
  handling.
- Preflight checks for Git, GitHub CLI authentication, repository state, labels, and local tooling.
- Worktree creation, cleanup, sync, and push helpers for stage execution.
- Reset, unblock, merge queue, PR check, and session utilities.
- Settings resolution and shared desktop/MCP support helpers.

## Public Surface

`src/index.ts` is the curated package surface used by Shipper workspace consumers. New helpers are
kept internal unless another workspace package needs them through the root export.

`src/internal.ts` is a source-only internal barrel for Shipper code paths that need deeper helpers.
It is not part of the documented package contract. Do not rely on deep imports,
`@baremetallabs-ai/shipper-core/*` subpaths, or undocumented source files for external
integrations.

## Installation Context

The package is published so the CLI package can depend on the exact matching core version and so
workspace consumers resolve consistently:

```bash
npm install @baremetallabs-ai/shipper-core
```

That install command is not a recommendation to build directly on core as an external API. For
normal Shipper usage, install the CLI:

```bash
npm install -g @baremetallabs-ai/shipper-cli
```

## Documentation

- Architecture: https://shipper.baremetallabs.ai/concepts/architecture/
- CLI reference: https://shipper.baremetallabs.ai/reference/cli/
- CLI npm package: https://www.npmjs.com/package/@baremetallabs-ai/shipper-cli
