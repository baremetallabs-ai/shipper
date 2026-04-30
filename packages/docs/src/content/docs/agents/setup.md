---
title: Repository setup for agents
description: Configure a repository so any coding agent can run Shipper reliably.
audience: agent
---

<!-- This page mirrors the configuration tasks from packages/core/src/prompts/claude/setup.md. Drift will occur over time; a future issue may add a generator or CI lint to enforce consistency. -->

# Repository setup for agents

Use this guide when you need to configure a repository for Shipper without running
`shipper setup`.

## Task 1: Configure the install command

Inspect the repository and write the dependency install command Shipper should run in new
worktrees.

1. Inspect root lockfiles and package manager signals.

   Check for `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`,
   `go.sum`, `requirements.txt`, `Pipfile.lock`, `poetry.lock`, and similar project files.

2. Read `.shipper/settings.json`.

   Preserve every existing setting. Only add or update `installCommand`.

3. Choose an install command that can resolve new dependencies.

   Use commands such as `npm install`, `pnpm install`, `yarn install`, `bun install`,
   `cargo build`, or `pip install -r requirements.txt`. Do not use `npm ci`,
   `--frozen-lockfile`, or other CI-only or frozen-lockfile variants because implementation
   agents may need to add dependencies.

4. Write the command to `.shipper/settings.json`.

   ```json
   {
     "installCommand": "npm install"
   }
   ```

   See [Reference > Settings](../reference/settings/) for the full settings shape.

5. Verify the install command through Shipper's script.

   Always invoke scripts in `.shipper/scripts/` with a relative path. Sandbox permission patterns
   match relative paths; absolute paths can be denied.

   ```sh
   ./.shipper/scripts/install-deps.sh
   ```

6. Report the configured command and the repository signal that justified it.

## Task 2: Generate or update the agent configuration file

Create or update the repository's agent configuration file so coding agents know which verification
commands to run.

1. Select the target file.

   Use `CLAUDE.md` for Claude Code. Use `AGENTS.md` for Codex or Copilot.

2. Discover CI commands from `.github/workflows/`.

   Treat workflow files as the source of truth. Read every workflow that exists and extract the
   exact lint, format-check, type-check, build, and test commands CI runs. Do not hardcode generic
   commands.

3. Update an existing file in place.

   If the target file exists, preserve its content. Add a `Commands` section if it does not have
   one. If it already has a commands section, verify it matches CI and update only the commands that
   need to change.

4. Create a missing file only with facts you can support.

   If the target file does not exist, create it with a brief project description inferred from the
   repository and a `Commands` section only when CI commands exist.

5. Skip commands when no CI configuration exists.

   If `.github/workflows/` is missing or has no CI commands, omit the `Commands` section in a new
   file. Leave an existing commands section unchanged.

6. Keep the file synchronized with any workflow you create later.

   If Task 3 writes `.github/workflows/pr-checks.yml`, immediately revisit this configuration file
   and make its `Commands` section match the selected checks.

## Task 3: Scaffold PR-check workflow if missing

Determine whether the repository already has PR-triggered GitHub Actions coverage. Create a workflow
only when coverage is missing.

1. Inspect `.github/workflows/*.yml` and `.github/workflows/*.yaml`.

   Treat a workflow as sufficient when its top-level `on:` block includes `pull_request`, a
   bare-list `pull_request` entry, or `pull_request_target`. Use tolerant string or line-based
   inspection. Do not add a YAML parser dependency.

2. Skip scaffolding when PR coverage exists.

   If any workflow already covers pull requests, skip the workflow scaffold and continue to Task 4.

3. Infer verification commands when PR coverage is missing.

   Reuse the repository signals from Tasks 1 and 2. The workflow install step must use the same
   configured `installCommand`.
   - For Node projects, infer scripts named `lint`, `format:check` or `format-check`, `typecheck`
     or `type-check`, `test`, and `build`.
   - For Cargo projects, infer `cargo fmt --check`, `cargo clippy`, `cargo test`, and
     `cargo build`.
   - For Go projects, infer `go vet`, `go test ./...`, and `go build ./...`.
   - For Python projects, infer commands from detected tools such as `ruff`, `mypy`, and `pytest`.

   Offer only commands you can justify from detected scripts, lockfiles, or tooling.

4. Continue without writing a workflow when no commands can be inferred.

   Explain that Shipper recommends lint, format-check, type-check, test, and build scripts plus a
   PR-checks workflow and branch protections because coding agents need deterministic green/red
   signals and Shipper's review and merge gates rely on them. Then continue to Task 4.

5. Present inferred commands and require confirmation before writing.

   Describe the planned workflow in natural language only. Do not preview file contents. Explain
   that `.github/workflows/pr-checks.yml` will run on `pull_request` against the default branch,
   using one human-readable `ubuntu-latest` job per selected command.

6. Resolve the default branch.

   ```sh
   gh api repos/{owner}/{repo} --jq .default_branch
   ```

7. Check for an existing target file before writing.

   If `.github/workflows/pr-checks.yml` already exists, do not overwrite it. Explain why and skip
   the write.

8. Write `.github/workflows/pr-checks.yml` only after explicit confirmation.

   Use `on: pull_request: branches: [<default branch>]`. Create one job per selected command. Each
   job should use `actions/checkout@v4`, the matching ecosystem setup action, the configured
   `installCommand`, and then the single verification command. Keep the workflow simple: no matrix,
   no file-content preview, and no caching beyond what the setup action provides by default.

9. Sync the agent configuration file.

   After writing the workflow, update `CLAUDE.md` or `AGENTS.md` so its `Commands` section matches
   the selected checks.

See [Reference > CLI](../reference/cli/) for command details.

## Task 4: Configure branch protections

Always ask whether to configure branch protections after Task 3 resolves, regardless of whether
scaffolding succeeded, was skipped, was declined, or had no inferred commands.

1. If the user declines, continue without configuring protections.

2. If the user approves, create a repository ruleset.

   Use `gh api repos/{owner}/{repo}/rulesets -X POST`. Target `~DEFAULT_BRANCH` and include a
   `name` field such as `Shipper PR Checks`.

3. Add required status checks only when selected check names exist.

   If selected check names exist, include a `required_status_checks` rule with those names. If no
   selected check names exist because scaffolding was declined or no commands could be inferred,
   explain that Shipper cannot configure a "require PR checks to pass" ruleset yet and do not send
   an empty `required_status_checks` rule.

4. Use a workflow-file rule only with the correct rule type.

   If Task 3 created `.github/workflows/pr-checks.yml` and you add a workflow-file rule, use the
   `workflows` rule type, not `required_workflows`. Resolve the repository ID first:

   ```sh
   gh api repos/{owner}/{repo} --jq .id
   ```

   Include both `repository_id` and `path: ".github/workflows/pr-checks.yml"` in the workflow
   entry.

5. Do not use classic branch protection APIs.

6. Handle permissions failures without failing setup.

   If `gh api` returns `403`, report that the user lacks permission to administer branch protections
   and continue setup.
