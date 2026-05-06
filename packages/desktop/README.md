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
and Linux builds are not currently distributed.

## First Run

1. Install and authenticate GitHub CLI:

   ```bash
   gh auth login
   ```

2. Download the latest macOS arm64 artifact from GitHub Releases and launch Shipper.
3. Add or select a repository in `owner/repo` format from the repo picker.
4. If the repository is not initialized, run setup/init when the app prompts for it.
5. Start from the pipeline board to create, adopt, groom, ship, review, remediate, unblock, reset,
   unlock, prioritize, pause/resume, or merge work.

Shipper workflows still run locally. The same Node.js, GitHub CLI, Git, and configured agent CLI
requirements that apply to the CLI also matter for desktop workflows.

## App Capabilities

The desktop app exposes the main Shipper workflow controls:

- Repository selection, repository search, active repo persistence, and prerequisite checks.
- Pipeline issue listing with GitHub-backed workflow state.
- New issue creation and adoption of existing GitHub issues.
- Interactive grooming and setup terminal sessions.
- Background `shipper new`, `shipper ship`, `shipper init`, and `shipper unblock` runs.
- Reset previews and execution, stale-lock checks, unlock, priority changes, and issue closure for
  not-planned work.
- Pause/resume controls, auto-ship, auto-merge, action queue state, toast notifications, logs, and
  terminal session management.

## Desktop or CLI

Use the desktop app when you want visual triage, queue monitoring, interactive grooming, terminal
sessions, pause/resume controls, and hands-on operation from a board.

Use the CLI when you want scripts, CI or container workflows, direct terminal commands, or explicit
automation around `shipper next`, `shipper ship`, and related commands.

Both entry points operate on the same GitHub issues, labels, comments, locks, settings, and stage
artifacts, so you can move between them as needed.

## Documentation

- Desktop guide: https://shipper.baremetallabs.ai/guides/desktop/
- Getting started: https://shipper.baremetallabs.ai/start-here/getting-started/
- CLI reference: https://shipper.baremetallabs.ai/reference/cli/
