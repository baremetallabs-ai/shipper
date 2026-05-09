---
title: Supported coding agents
description: Agent-specific setup facts for Claude Code, Codex CLI, and GitHub Copilot CLI.
audience: agent
---

# Supported coding agents

Most Shipper users arrive here with access to a coding agent already in place. This page is for
setting up the agent you have, not for choosing a winner between agents.

Use [`shipper setup`](/reference/cli/setup/) as the recommended path for preparing a repository for
Claude Code, Codex CLI, or GitHub Copilot CLI. If you are not running `shipper setup`, use
[Repository setup for agents](/agents/setup/) as the manual fallback.

## How Shipper selects an agent

Shipper uses `commands.default.agent` as the default coding agent for prompt-running commands.
Per-stage `commands.<stage>.agent` overrides can select a different agent for individual workflow
stages.

See [Reference > Settings](/reference/settings/) for the settings schema and
[Switch coding agents](/agents/cookbook/switch-coding-agent/) for the switching workflow.
Agent selection does not configure the MCP client itself; when you enable Shipper MCP tools in a
client, follow the [Shipper MCP client setup guide](/guides/mcp-setup/) for client-specific timeout
guidance.

## Claude Code

| Fact                     | Details                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI prerequisite         | Install Claude Code, authenticate it, and make sure the `claude` command is available before Shipper can drive it.                                                                                                                                                                                     |
| Repository config file   | Shipper expects `CLAUDE.md` for Claude Code. `shipper setup` should create or update that file and discover repository verification commands; the [manual setup guide](/agents/setup/) covers the fallback path.                                                                                       |
| Default Shipper behavior | Fresh Shipper settings default `commands.default.agent` to `"claude"` unless you select another agent. MCP loading is normal for prompt-running stages unless `disableMcp` settings or a one-run flag disable it, and `commands.groom.disableMcp` still defaults to `true` regardless of agent choice. |
| Practical implications   | Claude Code is the only supported agent that uses `CLAUDE.md`. If a repository needs to support multiple agents, keep both `CLAUDE.md` and `AGENTS.md` current. The current [Shipper MCP client setup guide](/guides/mcp-setup/) includes Claude Code.                                                 |

## Codex CLI

| Fact                     | Details                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI prerequisite         | Install Codex CLI, authenticate it, and make sure the `codex` command is available before Shipper can drive it.                                                                                                                                                                                                                                   |
| Repository config file   | Shipper expects `AGENTS.md` for Codex CLI. `shipper setup` should create or update that file and discover repository verification commands; the [manual setup guide](/agents/setup/) covers the fallback path.                                                                                                                                    |
| Default Shipper behavior | Fresh Shipper settings default to Claude, so select Codex with `commands.default.agent`, a per-stage override, or a one-run `--agent codex` flag. MCP loading is normal for prompt-running stages unless `disableMcp` settings or a one-run flag disable it, and `commands.groom.disableMcp` still defaults to `true` regardless of agent choice. |
| Practical implications   | Codex shares `AGENTS.md` with Copilot. Shipper handles the Codex command shape for Shipper runs, including worktree-specific behavior, so configure Shipper settings rather than wrapping the CLI yourself. The current [Shipper MCP client setup guide](/guides/mcp-setup/) includes Codex.                                                      |

## GitHub Copilot CLI

| Fact                     | Details                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI prerequisite         | Install GitHub Copilot CLI, authenticate it, and make sure the `copilot` command is available before Shipper can drive it.                                                                                                                                                                                                                            |
| Repository config file   | Shipper expects `AGENTS.md` for GitHub Copilot CLI. `shipper setup` should create or update that file and discover repository verification commands; the [manual setup guide](/agents/setup/) covers the fallback path.                                                                                                                               |
| Default Shipper behavior | Fresh Shipper settings default to Claude, so select Copilot with `commands.default.agent`, a per-stage override, or a one-run `--agent copilot` flag. MCP loading is normal for prompt-running stages unless `disableMcp` settings or a one-run flag disable it, and `commands.groom.disableMcp` still defaults to `true` regardless of agent choice. |
| Practical implications   | Copilot shares `AGENTS.md` with Codex. Shipper fails early with a missing-binary message if `copilot` is not on `PATH`. The current [Shipper MCP client setup guide](/guides/mcp-setup/) covers Claude Code and Codex, not Copilot.                                                                                                                   |
