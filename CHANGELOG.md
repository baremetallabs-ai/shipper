# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.0]

### Added

- Troubleshooting guide for common Shipper failures on the docs site (#781).
- `shipper init` drift guard: CI and the local pre-push hook now block drift between
  tracked `.shipper/` output and what `shipper init` would write (#774).
- Experimental adversarial design-review loop in the `design` stage (gated by a flag).
- Expanded Starlight docs site: recipes guide (#780), environment-variables reference
  (#782), `.shipper` directory reference (#783), hooks reference (#784), MCP setup guide
  (#785), supported coding agents page (#786), MCP architecture coverage (#792), and
  substantive index-page overviews (#788). Linux support is now declared for the CLI and
  MCP.
- Desktop operational workflows and Activity-drawer guidance in the desktop guide (#818).

### Changed

- `shipper new` now uses the output protocol: agents draft issue artifacts under
  `.shipper/output/`, then Shipper validates the draft, creates the GitHub issue, applies
  `shipper:new`, and records the final `created_issue` identity (#827).
- Renamed the desktop "Action Queue" drawer to "Activity" with restructured completed
  cards: a four-line layout, a status-or-stage badge, a hyperlinked issue reference, and
  the issue title surfaced from app state. Per-card stage resolution distinguishes merged
  ships, blocked unblocks, and pre-merge `shipper:ready` (#842).
- Restored close outcomes for groom runs under the file-based output protocol so groom can
  again signal a closed issue back to the workflow (#825).
- Relaxed CLI version freshness gating so minor/patch drift no longer hard-fails Shipper
  invocations; major drift still gates (#840).
- `shipper setup` no longer runs inside a sandbox; headless setup is rejected with a clear
  error and the Claude sandbox shim is removed (#787).
- Renamed the desktop action-queue status label `Complete` → `Succeeded` (#817).
- Hardened the groom prompt so the issue body never resolves product decisions, and
  carved the Duplicate-detection gate out of the Phase 3 anchor.

### Fixed

- Restricted the AskUserQuestion bridge to MCP runs, and preserved deferred-question
  ordering when headless batches arrive together (#835, #814).
- Full-decomposition grooming is accepted without parent details, and parent labels are
  cleaned up afterward (#836).
- Desktop action-log modal stays contained within its dialog; its scrollport is now
  focusable for keyboard users (#831).
- Lock-renewal log lines no longer disrupt interactive stage TUIs — output is buffered
  and drained around stage interaction (#826).
- Closed-groom summaries are now validated before being recorded (#825).
- Desktop GitHub releases no longer stay in draft; release state is normalized and the
  publish flow is guarded against stale tag runs (#773).
- Issues are unlocked when a desktop grooming session is intentionally aborted (#775).
- Avoided double punctuation in CLI group intro lines (#788).
- Hardened init drift remediation output (#774).
- Migration to Starlight 0.39's sidebar shape for the docs site.

### Maintenance

- Migrated the test suite to Vitest 4: API changes, stricter mock semantics, branch
  coverage thresholds, and the matching `@vitest/coverage-v8` bump.
- Added `RELEASING.md` documenting the tag-driven release process and the `Publish`
  workflow.
- Added Dependabot configuration for routine dependency updates (#776).
- Routine dependency bumps: `electron` 41 → 42, `electron-vite` 3 → 5, `@commitlint/cli`
  19 → 21, npm minor/patch group, and GitHub Actions
  (`checkout` 4 → 6, `setup-node` 4 → 6, `upload-pages-artifact` 3 → 5,
  `deploy-pages` 4 → 5).

### Migration notes

- Local `.shipper/prompts/<agent>/new.md` overrides written for the old `gh issue create`
  contract must be re-ejected with `shipper eject new` or migrated to write
  `.shipper/output/result.json` with `issue_draft`, plus `.shipper/output/issue-draft.json`
  and `.shipper/output/issue-body.md` (#827).

## [3.0.1]

### Added

- Added package-root READMEs for `@baremetallabs-ai/shipper-cli`,
  `@baremetallabs-ai/shipper-core`, `@baremetallabs-ai/shipper-mcp`, and
  `@baremetallabs-ai/shipper-desktop` so npm package pages and package directories provide
  substantive local orientation.
- Added session correlation for MCP issue creation so agent-created issues can carry Shipper
  workflow metadata through the output protocol.

### Changed

- Repositioned the desktop app throughout repository and product documentation as a supported,
  feature-parity entry point alongside the CLI.
- Rewrote the Desktop guide with install, first-run, CLI/desktop parity, shared-state, workflow,
  and current distribution-constraint guidance for first-time users.
- Bumped all Shipper workspace packages to `3.0.1` and updated workspace core dependency pins for
  the release.
- Shipper's own dogfood mode now downgrades CLI fingerprint drift from a hard failure to a warning
  while keeping user repositories strict.

### Fixed

- Fixed the desktop empty-state crosshair SVG so it ignores pointer events and no longer blocks
  clicks on the empty pipeline state.
- Preserved GitHub CLI diagnostics across review retry and output-protocol failure paths so
  failed agent runs surface actionable errors.

### Maintenance

- CI and the local pre-push hook now guard against drift between `.shipper/settings.json`'s
  `cliVersion` fingerprint and `packages/cli/package.json`'s `version`.
- Updated the npm publish workflow to use Trusted Publishers/OIDC provenance instead of an
  `NPM_TOKEN` secret.
- Forced desktop release packaging to pass `electron-builder --publish never` so packaging does not
  publish artifacts before the GitHub Release upload step.
- Added the private MCP package to the tag/version alignment check without adding an MCP publish
  step.

## [3.0.0]

### Changed

- **Breaking:** npm packages renamed from `@dnsquared/shipper-*` to `@baremetallabs-ai/shipper-*`. Install with `npm install -g @baremetallabs-ai/shipper-cli`.
- **Breaking:** GitHub repository moved from `dnsquared/shipper-cli` to `baremetallabs-ai/shipper`. Update existing remotes with `git remote set-url origin https://github.com/baremetallabs-ai/shipper.git`. GitHub auto-redirects URLs but the redirect is not durable.
- **Breaking:** packages now publish to the public npm registry (`https://registry.npmjs.org`) instead of GitHub Packages. End users no longer need a `.npmrc` with a GitHub Packages auth token.
- **Breaking:** desktop app `appId` changed from `com.dnsquared.shipper` to `ai.baremetallabs.shipper`. macOS treats existing installs as a separate app; reinstall to pick up updates against the new identity.
- **Breaking:** Groom prompt overrides at `.shipper/prompts/groom/<agent>.md` must now emit `.shipper/output/result.json` plus a groom manifest. Shipper performs all groom GitHub writes after the agent exits; overrides that still perform direct issue mutations or fail to emit the new artifacts are treated as failed groom runs.

### Added

- Starlight docs site with generated CLI and MCP reference pages.
- MCP documentation search and read tools.
- OSS-readiness scaffolding: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, GitHub issue and PR templates.

### Migration notes

- Per-repo session metadata under `~/.shipper/sessions/<owner>-<repo>/` and clones under `~/.shipper/repos/<owner>/<repo>/` are keyed by GitHub remote slug. After updating the remote, new runs write to `baremetallabs-ai-shipper`/`baremetallabs-ai/shipper`; old data under `dnsquared-shipper-cli`/`dnsquared/shipper-cli` is not migrated. Delete or copy the old directories as needed.

[Unreleased]: https://github.com/baremetallabs-ai/shipper/compare/v3.1.0...HEAD
[3.1.0]: https://github.com/baremetallabs-ai/shipper/compare/v3.0.1...v3.1.0
[3.0.1]: https://github.com/baremetallabs-ai/shipper/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/baremetallabs-ai/shipper/compare/v2.0.0...v3.0.0
