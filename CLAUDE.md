# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Shipper CLI

A CLI workflow orchestrator for GitHub-hosted repos. Each command launches a coding agent (e.g. `claude`) with a Markdown prompt file from `.shipper/prompts/`. Shipper handles orchestration; GitHub issues/labels are the source of truth for workflow state.

## Commands

```bash
npm run build          # Bundle with tsup → packages/cli/dist/
npm run dev            # Run via tsx (no build needed)
npm run type-check     # tsc --noEmit
npm run lint           # eslint .
npm run lint:fix       # eslint . --fix
npm run format         # prettier --write .
npm run test           # vitest run
npm run test:watch     # vitest (watch mode)
npx vitest run packages/cli/tests/lib/branch.test.ts   # Run a single test file
```

## Architecture

**Command pattern:** Each CLI command lives in `packages/cli/src/commands/<name>.ts` and exports a single async function. Commands follow: validate input → check prerequisites → execute action (usually `runPrompt()`).

**Prompt-driven execution:** Commands map to Markdown files in `packages/cli/src/prompts/`. Prompts have YAML frontmatter (`cmd`, `args`, `append-issue`, etc.). `runPrompt()` in `packages/cli/src/lib/prompt-runner.ts` spawns the configured agent CLI with the prompt as system message.

**Ephemeral worktrees:** Implementation/PR commands use temporary git worktrees stored in `~/.shipper/worktrees/`. `withWorktree()` in `packages/cli/src/lib/worktree.ts` handles create → callback → cleanup with signal handler support (SIGINT/SIGTERM).

**GitHub integration:** All GitHub interaction goes through the `gh` CLI (no REST API). See `packages/cli/src/lib/github.ts`.

**Workflow state machine via labels:** `shipper:new` → `shipper:groomed` → `shipper:designed` → `shipper:planned` → `shipper:implemented` → `shipper:pr-open` → `shipper:pr-reviewed` → `shipper:ready`. Control labels: `shipper:blocked` (dependency block), `shipper:locked` (active instance lock). The `next` command auto-advances based on current label.

## Code Conventions

- **ESM-only** with `.js` extensions on relative imports (required for Node ESM resolution)
- **Strict TypeScript** — `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`
- **Single runtime dependency:** `commander`. Everything else uses Node built-ins (`child_process`, `fs`, `path`, `os`)
- **Conventional commits** enforced via Husky + Commitlint: `type(scope): subject`
- **Prettier:** single quotes, trailing commas (es5), 100 char width, semicolons
- **File naming:** kebab-case for files, camelCase for functions, PascalCase for interfaces
- **Unused variables:** prefix with `_` to satisfy lint
