# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/baremetallabs-ai/shipper/compare/v3.0.1...HEAD
[3.0.1]: https://github.com/baremetallabs-ai/shipper/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/baremetallabs-ai/shipper/compare/v2.0.0...v3.0.0
