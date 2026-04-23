# Shipper CLI Workflow

Shipper CLI is an opinionated workflow runner for GitHub-hosted repos. Prompt-driven commands use prompts bundled with the CLI, while GitHub remains the source of truth for workflow state.

## Prerequisites

Shipper assumes:

- You are in a Git repo with a GitHub remote.
- `shipper init` has been run for the repo.

`shipper init`:

- Creates or updates `./.shipper/` (idempotent; can be re-run after upgrades).
- Ensures required GitHub labels exist for the workflow.
- Ensures required tooling is installed and configured (for example `gh` auth), or guides the user to do so.

If any command discovers missing prerequisites, it instructs the user to run `shipper init` and stops.

## Prompt-driven commands

Prompt-running commands use bundled prompts shipped inside `packages/core/src/prompts/<agent>/`.

At runtime, `runPrompt()` resolves prompts in this order:

- Local override: `./.shipper/prompts/<agent>/<name>.md`
- Bundled default: `packages/core/src/prompts/<agent>/<name>.md`

Use `shipper eject` to scaffold editable local overrides under `./.shipper/prompts/<agent>/`. Shipper still stores temporary runtime files under `./.shipper/tmp/`.

Shipper also ships `packages/mcp`, an MCP server that exposes the workflow tools to AI agents.

## MCP server

The MCP server exposes a workflow-oriented tool surface for agents that need to inspect or operate
on shipper-managed issues without shelling out to the CLI.

Available tools:

- `shipper_list_issues`: list open shipper-managed issues grouped by stage, with optional status filtering.
- `shipper_get_issue`: fetch issue details, labels, body, state, and any linked open PR.
- `shipper_get_pr_checks`: summarize PR check status with failed and pending details.
- `shipper_create_issue`: create a new `shipper:new` issue from a plain-text request.
- `shipper_advance`: advance an issue by one workflow step in headless mode.
- `shipper_unblock`: retry a blocked issue and report the unblock verdict.
- `shipper_merge`: run the ready-PR merge queue once.
- `shipper_unlock`: release one issue lock or sweep stale locks.
- `shipper_adopt`: apply `shipper:new` to an existing issue.
- `shipper_reset`: reset an issue back to an earlier workflow stage and clean up later artifacts.

`shipper_reset` inputs and behavior:

- Required inputs: `issue` (positive integer) and `target` (`new`, `groomed`, `designed`, `planned`, or `implemented`).
- Optional input: `dry_run` (boolean, defaults to `false`).
- Rejects pull request numbers and closed issues without making any changes.
- Rejects same-stage and forward resets; reset only works backward, with the same `implemented` exception the CLI allows for `shipper:pr-open`, `shipper:pr-reviewed`, and `shipper:ready`.
- Rejects fresh `shipper:locked` issues and tells the caller to release the lock with `shipper_unlock` before retrying. Stale locks are treated as unlocked.
- With `dry_run: true`, returns a preview of labels, comments, PRs, remote branches, local branches, and local worktrees that would be cleaned up, followed by `Dry run only; no changes made.`
- If the pre-run scan finds nothing to do, returns a normal success response stating that the issue is already clean for the requested target.
- On live runs, returns a full per-operation ledger. If any cleanup operation fails, the MCP response is marked `isError: true` but still includes every succeeded, skipped, and failed operation with reasons.

## State model

Workflow state is tracked in GitHub using labels on issues and PRs. Comments and issue bodies hold the human-readable artifacts produced by each stage.

Workflow states (the happy path):

`shipper:new` -> `shipper:groomed` -> `shipper:designed` -> `shipper:planned` -> `shipper:implemented` -> `shipper:pr-open` -> `shipper:pr-reviewed` -> `shipper:ready`

Reject verdicts move an issue backward to an earlier workflow label. `shipper next` and
`shipper ship` treat those rollbacks as interior workflow events rather than command failures, while
crashes and explicit `fail` verdicts remain terminal.

Control labels:

- `shipper:blocked` - dependency block, resolved by `shipper unblock`
- `shipper:locked` - active instance lock, resolved by `shipper unlock`
- `shipper:failed` - automated processing failed, requires investigation; resolved by `shipper reset`

Priority labels:

- `shipper:priority-high` - processed first in `ship --auto`
- `shipper:priority-low` - processed last in `ship --auto`

---

# End-to-end lifecycle

Stage commands that operate on issues (`groom`, `design`, `plan`, `implement`) accept an optional issue argument and, when omitted, auto-select the first eligible issue. Stage commands that operate on pull requests (`pr open`, `pr review`, `pr remediate`) accept an optional PR argument and, when omitted, auto-select the first eligible PR.

## 1) `shipper setup [words...]` (alias: `shipper agent`)

Purpose: configure repository settings with an agent.

Behavior:

- Runs the setup prompt before the rest of the workflow is used.
- Accepts optional freeform instructions, for example `shipper setup "change agent to codex"`.
- If no instructions are provided, seeds the prompt with repo-aware setup text.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- Updated `.shipper/` configuration for the repository.

## 2) `shipper new <request>`

Purpose: convert a rough idea into a lightweight, high-level GitHub issue.

Behavior:

- Agent asks a small number of clarifying questions.
- Agent drafts a concise issue with title, summary, acceptance criteria, out of scope, and notes.
- Runs inside a fresh ephemeral git worktree created from the configured base branch, so the agent drafts against the same clean view every downstream stage sees. Uncommitted or in-progress files in your checkout are not visible to the agent; commit and push them first or describe them in the request if they matter.
- Agent creates the issue via `gh issue create --body-file ...` and applies label `shipper:new`.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- A new GitHub issue labeled `shipper:new`.

## 3) `shipper groom [issue] [--auto]`

Purpose: make the issue decision-complete at the product level.

Behavior:

- Agent reads the full issue and comments.
- Agent explores the codebase only to understand existing user-facing behavior.
- Agent interviews the product owner to resolve missing product decisions.
- Agent updates the issue body, posts a grooming summary comment, and transitions the issue to `shipper:groomed`.
- `--auto` grooms all eligible `shipper:new` issues in sequence. It is mutually exclusive with an explicit issue number.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- Updated original issue body and grooming summary comment.
- Issue labeled `shipper:groomed`.
- Optional new `shipper:new` issues if the work is split.

## 4) `shipper design [issue]`

Purpose: make the issue decision-complete at the technical design level.

Behavior:

- Agent reads the issue plus grooming outputs.
- Agent explores the codebase to understand architecture and constraints.
- Agent posts a technical design comment and transitions the issue to `shipper:designed`.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- Design doc comment on the issue.
- Issue labeled `shipper:designed`.

## 5) `shipper plan [issue]`

Purpose: produce a detailed implementation plan with no open questions.

Behavior:

- Agent reads the issue and design.
- Agent identifies specific files and areas to change.
- Agent writes an implementation plan comment and transitions the issue to `shipper:planned`.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- Implementation plan comment.
- Issue labeled `shipper:planned`.

## 6) `shipper implement [issue]`

Purpose: implement the change on a new branch and push it.

Behavior:

- Shipper creates an ephemeral git worktree for the issue.
- Advisory install and worktree hooks may run on worktree creation.
- Agent implements according to the plan, runs checks, commits, pushes, and posts an implementation summary.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- Pushed branch.
- Implementation summary comment.
- Issue labeled `shipper:implemented`.

## 7) `shipper pr open [issue]`

Purpose: open a PR from the implemented branch.

Behavior:

- Shipper creates a fresh ephemeral worktree tracking the pushed branch.
- Agent runs quality checks, validates requirements, remediates if needed, and creates a PR.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- PR opened and linked to the issue.
- Issue labeled `shipper:pr-open`.

## 8) `shipper pr review [pr|issue]`

Purpose: create a first-pass review in GitHub review format.

Behavior:

- Agent reviews the PR diff against acceptance criteria and plan.
- Agent posts a GitHub review with actionable feedback.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- A GitHub PR review from Shipper.

## 9) `shipper pr remediate [pr|issue]`

Purpose: handle review feedback and prepare the PR for human merge.

Behavior:

- Shipper creates an ephemeral worktree on the PR branch.
- Agent pulls review feedback, applies accepted changes, runs checks, pushes updates, and replies to reviewers.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- PR updated and checks passing.
- Reviewer replies posted.
- Issue labeled `shipper:ready`.

## 10) `shipper unblock <issue>`

Purpose: check if a blocked issue's dependencies are resolved and clear the block.

Behavior:

- Reads the issue to determine what it is blocked on.
- If the dependency is resolved, removes `shipper:blocked` and instructs the user to continue with `shipper next`.
- Shared flags: `--mode <headless|interactive|default>`, `--agent <claude|codex>`, and `--model <model>`.

Output:

- Issue unblocked and ready to advance, or still blocked with an explanation.

---

# Orchestration commands

## `shipper next <ref> [--agent <name>]`

Purpose: advance an issue to the next workflow step based on its current label.

Behavior:

- Reads the current shipper label.
- Runs the corresponding next-stage command through the shared in-process stage dispatcher.
- If the stage rejects, logs the rolled-back workflow label and exits zero. Crashes and explicit
  `fail` verdicts still exit non-zero.
- Works with both issue numbers and PR numbers.
- `--agent <claude|codex>` overrides the agent used for the dispatched step.
- `--model <model>` overrides the model used for the dispatched step.

Output:

- The issue advances one step in the workflow or is left at the rolled-back label after a reject.

## `shipper ship <issue> [--merge]` or `shipper ship --auto [--parallel <n>] [--agent <name>]`

Purpose: run the full workflow end-to-end.

Behavior:

- Runs the remaining stages through the same in-process stage dispatcher used by `shipper next`.
- Reject verdicts roll the issue back and the per-issue ship loop resumes from the new label. A
  resumed issue that eventually reaches `shipper:ready` is reported as a normal pass.
- If a reject rolls a single-issue run back to `shipper:new`, `shipper ship <issue>` stops before
  running interactive `groom`, leaves the issue at `shipper:new`, logs that grooming is required,
  and exits zero.
- `--merge` auto-merges the PR after reaching `shipper:ready`.
- `--auto` runs a continuous loop that auto-selects issues, ships them, and merges their PRs. It
  is mutually exclusive with an explicit issue number and implies `--merge`.
- In auto-ship, non-NEW rejects stay interior to the per-issue run. A reject that rolls back to
  `shipper:new` is still recorded as a failure and skipped for the rest of that auto run because
  grooming is interactive and `shipper:new` is not an auto candidate.
- `--parallel <n>` sets the number of parallel slots in auto-ship mode and requires `--auto`.
  Sequential auto runs stay in-process; parallel auto uses one worker process per active issue over
  a small IPC protocol.
- `--agent <claude|codex>` overrides the agent used by dispatched steps.
- `--model <model>` overrides the model used by dispatched steps.

Output:

- The issue progresses through all remaining stages, including resumed reject loops when needed.

## `shipper merge [number] [--once] [--dry-run] [--interval <seconds>] [--repo <owner/repo>]`

Purpose: merge queue for PRs labeled `shipper:ready`.

Behavior:

- Polls for PRs labeled `shipper:ready` and merges them one at a time.
- If a specific PR or issue number is given, merges only that PR.
- `--once` processes the queue once and exits.
- `--dry-run` prints actions without executing them.
- `--interval <seconds>` sets the polling interval (default: `60`).
- `--repo <owner/repo>` targets a specific repository instead of inferring from the current working directory.

Output:

- PRs are merged and cleaned up.

---

# Utility commands

## `shipper adopt <issue>` or `shipper adopt --all`

Purpose: bring existing GitHub issues into the shipper workflow.

Behavior:

- `shipper adopt <issue>` applies `shipper:new` to a single issue.
- `shipper adopt --all` adopts every open issue that does not already have a shipper workflow label.

Output:

- Selected issues are labeled `shipper:new`, ready for `groom` or `next`.

## `shipper eject [name]`

Purpose: scaffold prompt overrides for customization.

Behavior:

- Writes prompt overrides to `./.shipper/prompts/<agent>/`, using the default agent from `settings.commands.default.agent`.
- With no `name`, ejects the nine workflow prompts: `new`, `groom`, `design`, `plan`, `implement`, `pr-open`, `pr-review`, `pr-remediate`, and `unblock`.
- `setup` is intentionally excluded from the default eject set.
- With `name`, ejects a single prompt override using the same names listed above.
- Existing files are left in place and reported as skipped.

Output:

- Local prompt override files ready for editing.

## `shipper priority <issue> <high|normal|low>`

Purpose: set the processing priority for an issue.

Behavior:

- Sets, changes, or clears priority labels on a shipper-managed issue.
- The issue must be open and already be in the shipper workflow.
- `high` adds `shipper:priority-high` and removes `shipper:priority-low`.
- `low` adds `shipper:priority-low` and removes `shipper:priority-high`.
- `normal` removes both priority labels, restoring default priority.

Output:

- Prints whether the priority changed, for example `Issue #<number> priority set to <level>.`

## `shipper issue list [--status <name>]`

Purpose: list shipper-managed issues by pipeline status.

Behavior:

- Groups open shipper-managed issues by their most advanced workflow label.
- `--status <name>` filters to a single stage or control status.
- Valid short status names are `new`, `groomed`, `designed`, `planned`, `implemented`, `pr-open`, `pr-reviewed`, `ready`, `blocked`, and `failed`.
- Blocked and failed issues are grouped into separate sections.
- Locked issues show a `[locked]` suffix.

Output:

- Grouped issue lists, or `No shipper-managed issues found.`

## `shipper reset <issue> [-f | --force] [--to <stage>]`

Purpose: reset an issue back to an earlier workflow stage.

Behavior:

- Without `--to`, prompts you to choose an earlier valid target stage interactively.
- With `--to <stage>`, resets directly to the named earlier stage.
- The same cleanup capability is available to MCP clients via `shipper_reset`. The MCP tool always requires an explicit target, never prompts for confirmation, does not expose a lock-override flag, and supports `dry_run` previews.
- Valid targets are earlier workflow stages: `new`, `groomed`, `designed`, `planned`, and `implemented`.
- Cleans up later-stage artifacts by closing associated PRs and, for any closed PR whose head ref starts with `shipper/`, attempting to delete that remote branch; it also removes matching local branches and worktrees, deletes later issue comments, and re-applies the target workflow label.
- Posts a reset notice comment after cleanup.
- Prompts for confirmation unless `-f` or `--force` is passed.

Output:

- Issue reset to the selected earlier stage with later artifacts cleaned up.

## `shipper unlock [issue] [--stale]`

Purpose: force-release the `shipper:locked` label on an issue, or sweep all stale locks.

Behavior:

- `shipper unlock <issue>` removes the `shipper:locked` label from the specified issue.
- `shipper unlock --stale` releases all stale locks across the repository.

Output:

- Lock released. The issue can be worked on by a new shipper instance.

---

# Worktrees & hooks

Implementation and PR-affecting commands run in ephemeral worktrees that are created for the duration of the command and then deleted.

- Executable file hooks can live under `./.shipper/hooks/`.
- `installCommand` runs as an advisory dependency-install step after worktree creation.
- File-based hooks in `.shipper/hooks/` handle worktree lifecycle events (`worktree-setup`, `worktree-teardown`).

---

# Settings

Settings are stored in `.shipper/settings.json` (created by `shipper init`). Local overrides can be placed in `.shipper/settings.local.json`, which is gitignored.

| Setting                      | Default                                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prReviewWait`               | `{ "mode": "checks", "maxDurationMinutes": 30 }` | PR review wait strategy. Timer mode uses `{ "mode": "timer", "durationMinutes": 30 }` measured from PR creation time. Checks mode uses a JSON object such as `{ "mode": "checks", "minDurationMinutes": 10, "maxDurationMinutes": 30 }`; `minDurationMinutes` and `maxDurationMinutes` are both optional, `minDurationMinutes` enforces a minimum review window from PR creation time, and omitting `maxDurationMinutes` waits indefinitely for checks. |
| `lockTimeoutMinutes`         | `30`                                             | Stale lock timeout in minutes before `shipper:locked` is considered stale.                                                                                                                                                                                                                                                                                                                                                                              |
| `agentTimeoutMinutes`        | `60`                                             | Agent process timeout for headless runs in minutes. Set to `0` to disable the timeout.                                                                                                                                                                                                                                                                                                                                                                  |
| `commands`                   | `{ "default": { "agent": "claude" } }`           | Per-command settings map. `default` is required. Optional per-step overrides may set `agent`, `mode`, or `model` for `new`, `groom`, `design`, `plan`, `implement`, `pr_open`, `pr_review`, `pr_remediate`, `unblock`, and `setup`. CLI names with hyphens use underscores here, so `pr-open`, `pr-review`, and `pr-remediate` become `pr_open`, `pr_review`, and `pr_remediate`.                                                                       |
| `commands.default.model`     | unset                                            | Default model override for all supported prompt-running steps.                                                                                                                                                                                                                                                                                                                                                                                          |
| `defaultBaseBranch`          | auto-detected                                    | Target branch for PRs if you do not set one explicitly.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `installCommand`             | unset                                            | Shell command used for the advisory dependency-install step in new worktrees.                                                                                                                                                                                                                                                                                                                                                                           |
| `worktreeEnv`                | unset                                            | Environment variables applied inside worktree execution. Values are merged with built-in cache directory defaults.                                                                                                                                                                                                                                                                                                                                      |
| `merge.requirePassingChecks` | `true`                                           | Require all CI checks to pass before auto-merging.                                                                                                                                                                                                                                                                                                                                                                                                      |

---

# Failure handling

If the agent discovers:

- Missing prerequisites (`gh`, auth, labels) -> instruct `shipper init` and stop.
- Missing product decisions during later phases -> recommend returning to `shipper groom`.
- Missing technical decisions during implementation -> recommend returning to `shipper design` or `shipper plan`.
- Oversized scope -> recommend splitting into additional issues created in `shipper:new`.
