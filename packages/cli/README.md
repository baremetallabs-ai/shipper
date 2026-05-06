# @baremetallabs-ai/shipper-cli

The Shipper CLI is the public command-line entry point for Shipper. It orchestrates
GitHub-backed issue workflows with coding agents, moving issues through grooming, design, planning,
implementation, PR review, remediation, and merge readiness while GitHub remains the source of
truth.

Shipper is not a generic task runner and it is not a coding agent. It gives agent-assisted software
delivery a repeatable lifecycle: each stage has a command, a contract, GitHub labels, and durable
issue or PR artifacts.

## Prerequisites

- Node.js 18 or newer.
- A Git repository hosted on GitHub.
- GitHub CLI installed and authenticated with `gh auth login`.
- A supported coding agent CLI configured in Shipper settings. Shipper supports `claude`, `codex`,
  and `copilot`.

## Install

```bash
npm install -g @baremetallabs-ai/shipper-cli
```

Initialize Shipper in each GitHub repository before running workflow commands:

```bash
shipper init
```

`shipper init` creates or updates local `.shipper/` configuration, verifies local prerequisites, and
ensures the workflow labels exist in GitHub.

## First Workflow

Create an issue from a rough request:

```bash
shipper new "your idea"
```

Advance one stage at a time:

```bash
shipper next <issue>
```

Or ask Shipper to run the remaining workflow for an issue:

```bash
shipper ship <issue>
```

For queue-style operation, `shipper ship --auto` selects eligible issues by workflow state and
priority.

## Command Surface

- Setup: `shipper init` and `shipper setup` configure repository state and agent settings.
- Intake and adoption: `shipper new`, `shipper adopt`, and `shipper issue list` create, adopt, and
  inspect Shipper-managed issues.
- Staged workflow: `shipper groom`, `shipper design`, `shipper plan`, `shipper implement`,
  `shipper next`, and `shipper ship` move issues through the lifecycle.
- PR workflow: `shipper pr open`, `shipper pr review`, and `shipper pr remediate` open pull
  requests, inspect review feedback, and run remediation work.
- Merge queue: `shipper merge` processes ready PRs after review and checks are satisfied.
- Recovery: `shipper reset`, `shipper unblock`, and `shipper unlock` recover from blocked stages,
  stale locks, or a needed rollback.
- Prompt customization: `shipper eject` copies bundled prompts into the repository for local
  overrides.
- Priority: `shipper priority` marks issues as high, normal, or low priority for auto-ship ordering.

## Documentation

- Getting started: https://shipper.baremetallabs.ai/start-here/getting-started/
- CLI reference: https://shipper.baremetallabs.ai/reference/cli/
- Desktop guide: https://shipper.baremetallabs.ai/guides/desktop/

The desktop app is a supported peer entry point for the same Shipper workflows when you want visual
triage, queue monitoring, and hands-on control.
