# Shipper

An opinionated workflow runner for GitHub-hosted repos.

Shipper came from the boring part of agent-assisted development: the follow-up work after a coding
agent can edit files. Issues still need grooming, designs still need review, plans still need to be
made explicit, PRs still need to be opened, checked, reviewed, remediated, and merged. Shipper keeps
that lifecycle in GitHub so the agent work has a durable shape instead of a chat transcript.

Full documentation: https://shipper.baremetallabs.ai

> Hero asset slot: add launch image or short product video here.

## Why this exists

Coding agents are useful, but they still make you micromanage issue state, context handoff, review
loops, and cleanup. Shipper sits as the SDLC layer above the coding agent. It turns each stage into a
repeatable GitHub-backed workflow instead of another manual prompt thread.

## The shape

`new -> groomed -> designed -> planned -> implemented -> pr-open -> pr-reviewed -> ready`

## What this isn't

- Not a coding agent: it runs Claude, Codex, or Copilot against a stage contract.
- Not CI: it can wait on checks and merge, but your CI system still owns validation.
- Not a prompt library: prompts are part of the workflow, not the product by themselves.

## 30-second quickstart

```bash
npm install -g @baremetallabs-ai/shipper-cli
shipper init
shipper new "your idea"
shipper ship --auto
```

## Maturity & scope

The project currently includes the CLI, a macOS desktop app in early development, an MCP server, and
three-agent support for `claude`, `codex`, and `copilot`. The workflow is GitHub-only today. The
desktop app is macOS-only today.

## Architecture

Shipper stores workflow state in GitHub labels and stage artifacts in issue bodies and comments,
then runs prompt-driven agents in clean worktrees to move issues through the lifecycle. The docs site
has the full architecture, state-machine, protocol, CLI, MCP, settings, and container references:
https://shipper.baremetallabs.ai
AI agents can pull the full docs corpus via [llms.txt](https://shipper.baremetallabs.ai/llms.txt) and [llms-full.txt](https://shipper.baremetallabs.ai/llms-full.txt).

## Status & support posture

This is a personal project. Support is best-effort, PRs are welcome, and there is no SLA. Use the
[GitHub issue tracker](https://github.com/baremetallabs-ai/shipper/issues) for bugs and requests.

Apache 2.0 — see LICENSE
