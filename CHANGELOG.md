# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CI and the local pre-push hook now guard against drift between `.shipper/settings.json`'s
  `cliVersion` fingerprint and `packages/cli/package.json`'s `version`.

### Changed

- Shipper's own dogfood mode now downgrades CLI fingerprint drift from a hard failure to a warning
  while keeping user repositories strict.

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

[Unreleased]: https://github.com/baremetallabs-ai/shipper/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/baremetallabs-ai/shipper/compare/v2.0.0...v3.0.0
