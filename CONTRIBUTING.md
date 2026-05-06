# Contributing to Shipper

Thanks for your interest in contributing. Shipper is an opinionated workflow runner for GitHub-hosted repos and is open to community contributions of all sizes.

Full project documentation lives at <https://shipper.baremetallabs.ai>.

## Development setup

Requirements:

- Node.js >= 18 (LTS recommended)
- A working `gh` CLI authenticated against GitHub
- macOS or Linux (the desktop package is macOS-only at present)

```bash
git clone https://github.com/baremetallabs-ai/shipper.git
cd shipper
npm install
npm run build
```

## Common commands

```bash
npm run build          # Build all workspaces (core builds first)
npm run dev            # Run the CLI via tsx (no build needed)
npm run type-check     # tsc --noEmit across workspaces
npm run lint           # eslint .
npm run lint:fix       # eslint . --fix
npm run format         # prettier --write .
npm run check:cli-version-fingerprint # Verify .shipper/settings.json matches CLI manifest version
npm run test           # vitest run, per workspace
npm run test:coverage  # vitest run --coverage, per workspace
```

For a package-specific run, use `--workspace=packages/<name>`, e.g.
`npm run test --workspace=packages/cli`.

## Commit style

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) enforced via Husky and Commitlint. Subjects look like:

```
type(scope): subject
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`.

## Pull requests

1. Branch from `main` and keep PRs focused on a single change.
2. Make sure `npm run build`, `npm run lint`, `npm run type-check`, and `npm run test` all pass locally before opening a PR.
3. Update or add tests where the change is testable.
4. Note any user-visible change in `CHANGELOG.md` under `[Unreleased]`.
5. When intentionally changing `packages/cli/package.json`'s `version`, rerun `shipper init` so `.shipper/settings.json`'s `cliVersion` is refreshed. If the version bump was unintended, revert or align the manifest instead.
6. Fill in the PR template; reference the issue you are addressing.

The pre-push hook and CI both run `npm run check:cli-version-fingerprint` before the broader validation suite. CI runs `check` (docs, lint, format, type-check, build, coverage) on Ubuntu and `desktop-macos` on macOS. Both must pass before merge.

## Filing issues

For bugs, please include reproduction steps, expected vs actual behaviour, and the output of `shipper --version`. For feature requests, please describe the user-visible behaviour you want and why.

For security-sensitive reports, see [SECURITY.md](SECURITY.md).

## Code of conduct

Participation in this project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
