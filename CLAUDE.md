# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Shipper CLI

A CLI workflow orchestrator for GitHub-hosted repos. Prompt-driven commands use prompts bundled with the CLI, with optional repo-local overrides under `.shipper/prompts/<agent>/`. Shipper handles orchestration; GitHub issues and labels are the source of truth for workflow state.

This repo is a small monorepo with four packages:

- `packages/cli` - the CLI entrypoint and command implementations
- `packages/core` - shared library code for prompts, settings, GitHub integration, worktrees, and locking
- `packages/desktop` - Electron desktop app in early development
- `packages/mcp` - MCP server exposing Shipper workflow tools to AI agents

## Commands

```bash
npm run build          # Bundle with tsup -> packages/cli/dist/
npm run dev            # Run via tsx (no build needed)
npm run type-check     # tsc --noEmit
npm run lint           # eslint .
npm run lint:fix       # eslint . --fix
npm run format         # prettier --write .
npm run test           # vitest run (per-workspace)
npm run test:coverage  # vitest run --coverage (per-workspace)
npm run test:watch     # vitest (watch mode)
```

**Important:** Always run tests via `npm run test` (workspace scripts). For package-specific runs, use the same workspace pattern as the root config, for example `npm run test --workspace=packages/cli`.

## CI

**PR Jobs:** Every pull request to `main` runs two GitHub Actions CI jobs: `check` on Ubuntu and `desktop-macos` on macOS.

**desktop-macos:** Builds `packages/core`, builds and tests `packages/desktop`, and runs an unpacked (`--dir`) `electron-builder` packaging smoke test without publishing release artifacts.

**Merge gating:** `check` is required today. `desktop-macos` is intended to be required as well and becomes merge-blocking once it is added to `main`'s required status checks.

## Architecture

**Command pattern:** Each CLI command lives in `packages/cli/src/commands/<name>.ts` and exports a single async function. Commands follow: validate input -> check prerequisites -> execute action, usually by dispatching to shared core helpers.

**Prompt-driven execution:** Bundled prompts live in `packages/core/src/prompts/`. `runPrompt()` in `packages/core/src/lib/prompt-runner.ts` resolves a repo-local override in `.shipper/prompts/<agent>/` before falling back to the bundled prompt, then spawns the configured agent CLI.

**Ephemeral worktrees:** Implementation and PR commands use temporary git worktrees stored in `~/.shipper/worktrees/`. `withWorktree()` in `packages/core/src/lib/worktree.ts` handles create -> callback -> cleanup with signal handler support.

**Ship orchestration:** `packages/cli/src/commands/stage-dispatch.ts` is the shared in-process stage entry used by `shipper next` and sequential `shipper ship`. Parallel auto-ship keeps fault isolation by forking `packages/cli/src/ship-worker.ts` and exchanging one run message plus one result message over IPC.

**GitHub integration:** All GitHub interaction goes through the `gh` CLI. See `packages/core/src/lib/github.ts`. Any structured `gh --json` payload must be parsed through `packages/core/src/lib/gh-schemas.ts` or `packages/core/src/lib/gh-json.ts`; do not use `JSON.parse(...) as T` for `gh` output.

**Workflow state machine via labels:** `shipper:new` -> `shipper:groomed` -> `shipper:designed` -> `shipper:planned` -> `shipper:implemented` -> `shipper:pr-open` -> `shipper:pr-reviewed` -> `shipper:ready`. Control labels: `shipper:blocked`, `shipper:locked`, and `shipper:failed`. Priority labels: `shipper:priority-high` and `shipper:priority-low`. The `next` command auto-advances based on the current workflow label.

## Code Conventions

- **ESM-only** with `.js` extensions on relative imports
- **Strict TypeScript** with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, and `verbatimModuleSyntax`
- **Runtime dependencies:** the CLI package depends on `commander` and `@dnsquared/shipper-core`; the core package's only runtime dependency is `zod` and otherwise uses Node built-ins
- **Conventional commits** enforced via Husky and Commitlint: `type(scope): subject`
- **Prettier:** single quotes, trailing commas (es5), 100 char width, semicolons
- **File naming:** kebab-case for files, camelCase for functions, PascalCase for interfaces
- **Type imports:** `import type { Foo } from ...` enforced by `consistent-type-imports` rule
- **No floating promises:** all promises must be `await`ed or explicitly `void`ed
- **Unused variables:** prefix with `_` to satisfy lint
- **Core public API:** `packages/core/src/index.ts` is the curated public surface for workspace consumers
- **Core internal barrel:** `packages/core/src/internal.ts` is the source-only barrel for non-public helpers inside `packages/core`
- **Default to internal:** new helpers belong in the internal surface unless an external consumer justifies promoting them into `packages/core/src/index.ts`
- **No deep imports into core:** any `packages/core/src/**` relative import or `@dnsquared/shipper-core/*` subpath import from outside `packages/core` is prohibited and enforced by ESLint
- **Vitest globals:** `describe`, `it`, `expect`, `vi` etc. are available globally in tests (no imports needed)
- **Build order:** core must build before cli (`npm run build` handles this automatically)
