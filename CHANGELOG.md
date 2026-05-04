# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** Groom prompt overrides at `.shipper/prompts/groom/<agent>.md` must now emit `.shipper/output/result.json` plus a groom manifest. Shipper performs all groom GitHub writes after the agent exits; overrides that still perform direct issue mutations or fail to emit the new artifacts are treated as failed groom runs.

### Added

- Starlight docs site with generated CLI and MCP reference pages.
- MCP documentation search and read tools.

[Unreleased]: https://github.com/dnsquared/shipper-cli/compare/v2.0.0...HEAD
