# @baremetallabs-ai/shipper-desktop

`@baremetallabs-ai/shipper-desktop` is Shipper's supported Electron desktop app. It provides a
visual entry point for the same GitHub-backed issue lifecycle as the CLI: intake, grooming, design,
planning, implementation, PR review, remediation, and merge readiness.

The desktop app is at feature parity with the CLI for the issue lifecycle and shares the same
Shipper core engine, GitHub labels, issue comments, settings, locks, stage artifacts, and local
workflow conventions. There is no separate desktop-only project database.

This package is private to the workspace and is built into desktop release artifacts.

## Distribution

Current release artifacts are attached to GitHub Releases:

https://github.com/baremetallabs-ai/shipper/releases

The distributed artifacts are macOS arm64 DMG and zip builds. The app is unsigned and not
code-signed today, so macOS may require the usual manual confirmation before first launch. Windows
and Linux desktop builds are not currently distributed. The CLI and MCP still run on macOS and
Linux: the CLI is published to npm as `@baremetallabs-ai/shipper-cli`, and the MCP server is a
private workspace package run from a source checkout (see the MCP setup guide).

## Operating Guide

The docs site is authoritative for day-to-day desktop operation:

https://shipper.baremetallabs.ai/guides/desktop/

## Local Prerequisites

Shipper workflows still run locally, so package readers need:

- Git and a GitHub-hosted repository.
- GitHub CLI installed and authenticated with `gh auth login`.
- Node.js.
- The configured agent CLI for stages that invoke an agent.
