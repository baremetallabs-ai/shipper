# Repository Guidelines

## Project Structure & Module Organization

This repo is an npm workspaces monorepo with four packages under `packages/`:

- `packages/core`: shared workflow logic, prompt resolution, GitHub helpers, scripts, and tests in `tests/`.
- `packages/cli`: the `shipper` CLI entrypoint and command implementations in `src/commands/`, with Vitest coverage in `tests/`.
- `packages/desktop`: Electron app code split across `src/main`, `src/preload`, and `src/renderer`, plus smoke tests in `tests/`.
- `packages/mcp`: MCP server that exposes Shipper workflow tools to AI agents, with tests in `tests/`.

Bundled agent prompts live in `packages/core/src/prompts/`. Build output goes to `packages/*/dist` or `packages/desktop/out` and should not be edited directly.

## Build, Test, and Development Commands

- `npm install`: install workspace dependencies and Husky hooks.
- `npm run build`: build `core`, `cli`, `mcp`, and `desktop`.
- `npm run dev -- <args>`: run the CLI in development mode via `tsx`.
- `npm run lint`: run ESLint across the repo.
- `npm run format:check`: verify Prettier formatting.
- `npm run type-check`: run TypeScript checks for all packages.
- `npm run test`: run all Vitest suites.
- `npm run test --workspace=packages/cli`: run one package’s tests.

## Coding Style & Naming Conventions

Use TypeScript with ESM imports, including `.js` on relative import paths where required by the source tree. Formatting is enforced by Prettier: 2-space indentation, single quotes, semicolons, trailing commas (`es5`), and 100-character lines. ESLint uses strict type-aware rules; prefix intentionally unused variables with `_`.

Prefer `kebab-case` for file names, `camelCase` for functions and variables, and `PascalCase` for React components and types.

## Testing Guidelines

Vitest is the test runner in every package. Keep tests near the package they cover in `packages/*/tests`, using `*.test.ts` naming such as `packages/core/tests/lib/worktree.test.ts`. Run `npm run test:coverage` when changing behavior across packages; there is no published coverage threshold, so rely on meaningful assertions around workflow transitions, CLI behavior, and Electron smoke paths.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits and are checked by Commitlint: `feat(scope): subject`, `fix(#280): subject`, `refactor(lint): subject`. Keep subjects imperative and concise.

Before pushing, Husky runs `lint`, `format:check`, `type-check`, `build`, and `test`. PRs should explain user-visible behavior, link the relevant issue or PR number, and include screenshots only for desktop renderer changes.
