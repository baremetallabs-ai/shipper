# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Shipper CLI

A CLI workflow orchestrator for GitHub-hosted repos. Prompt-driven commands use prompts bundled with the CLI, with optional repo-local overrides under `.shipper/prompts/<agent>/`. Shipper handles orchestration; GitHub issues and labels are the source of truth for workflow state.

This repo is a small monorepo:

- `packages/cli` - the CLI entrypoint and command implementations
- `packages/core` - shared library code for prompts, settings, GitHub integration, worktrees, and locking
- `packages/desktop` - Electron desktop app in early development

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
npx vitest run packages/cli/tests/lib/branch.test.ts   # Run a single test file
```

**Important:** Always run tests via `npm run test` (workspace scripts), never `npx vitest run` from the repo root. The root has no vitest config — running there picks up all test files without per-package alias resolution and will produce false failures.

## CI

**PR Jobs:** Every pull request to `main` runs two GitHub Actions CI jobs: `check` on Ubuntu and `desktop-macos` on macOS.

**desktop-macos:** Builds `packages/core`, builds and tests `packages/desktop`, and runs an unpacked (`--dir`) `electron-builder` packaging smoke test without publishing release artifacts.

**Merge gating:** `check` is required today. `desktop-macos` is intended to be required as well and becomes merge-blocking once it is added to `main`'s required status checks.

## Architecture

**Command pattern:** Each CLI command lives in `packages/cli/src/commands/<name>.ts` and exports a single async function. Commands follow: validate input -> check prerequisites -> execute action, usually by dispatching to shared core helpers.

**Prompt-driven execution:** Bundled prompts live in `packages/core/src/prompts/`. `runPrompt()` in `packages/core/src/lib/prompt-runner.ts` resolves a repo-local override in `.shipper/prompts/<agent>/` before falling back to the bundled prompt, then spawns the configured agent CLI.

**Ephemeral worktrees:** Implementation and PR commands use temporary git worktrees stored in `~/.shipper/worktrees/`. `withWorktree()` in `packages/core/src/lib/worktree.ts` handles create -> callback -> cleanup with signal handler support.

**GitHub integration:** All GitHub interaction goes through the `gh` CLI. See `packages/core/src/lib/github.ts`.

**Workflow state machine via labels:** `shipper:new` -> `shipper:groomed` -> `shipper:designed` -> `shipper:planned` -> `shipper:implemented` -> `shipper:pr-open` -> `shipper:pr-reviewed` -> `shipper:ready`. Control labels: `shipper:blocked` and `shipper:locked`. The `next` command auto-advances based on the current workflow label.

## Code Conventions

- **ESM-only** with `.js` extensions on relative imports
- **Strict TypeScript** with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, and `verbatimModuleSyntax`
- **Runtime dependencies:** the CLI package depends on `commander` and `@dnsquared/shipper-core`; the core package uses only Node built-ins at runtime
- **Conventional commits** enforced via Husky and Commitlint: `type(scope): subject`
- **Prettier:** single quotes, trailing commas (es5), 100 char width, semicolons
- **File naming:** kebab-case for files, camelCase for functions, PascalCase for interfaces
- **Type imports:** `import type { Foo } from ...` enforced by `consistent-type-imports` rule
- **No floating promises:** all promises must be `await`ed or explicitly `void`ed
- **Unused variables:** prefix with `_` to satisfy lint
- **Core barrel export:** new public APIs in `packages/core/src/lib/` must be re-exported from `packages/core/src/index.ts`
- **Vitest globals:** `describe`, `it`, `expect`, `vi` etc. are available globally in tests (no imports needed)
- **Build order:** core must build before cli (`npm run build` handles this automatically)
