# Shipper CLI Workflow

Shipper CLI is an opinionated workflow runner for GitHub-hosted repos. Each Shipper command launches a configured coding agent (e.g. `claude`) with a repo-local prompt file under `./.shipper/prompts/`. Shipper’s responsibility is orchestration; GitHub is the source of truth for workflow state.

## Prerequisites

Shipper assumes:

- You are in a Git repo with a GitHub remote.
- `shipper init` has been run for the repo.

`shipper init`:

- Creates/updates `./.shipper/` (idempotent; can be re-run after upgrades).
- Ensures required GitHub labels exist for the workflow.
- Ensures required tooling is installed/configured (e.g. `gh` auth), or guides the user to do so.

If any command discovers missing prerequisites (no `gh`, not authenticated, missing labels, etc.), it instructs the user to run `shipper init` and stops.

## Prompt-driven commands

Each command maps to a Markdown prompt file:

- `./.shipper/prompts/<command>.md`

Prompt files include YAML frontmatter specifying:

- `cmd`: which agent CLI to run (e.g. `claude`)
- `args`: arguments (e.g. `--model opus`)

Shipper executes the prompt by launching `cmd` with `args` and feeding the prompt content. The user’s command arguments (e.g. `shipper new <pitch>`) are injected as the initial user message.

Temporary files created during runs must be stored under:

- `./.shipper/tmp/`

## State model

Workflow state is tracked in GitHub using labels on issues (and optionally PRs). Comments and issue bodies hold the human-readable artifacts produced by each stage.

Recommended labels:

- `shipper:new`
- `shipper:groomed`
- `shipper:designed`
- `shipper:planned`
- `shipper:implemented`
- `shipper:pr-open`
- `shipper:ready`

(Additional “blocked” labels are optional; not required for v0.)

---

# End-to-end lifecycle

## 1) `shipper new <pitch>`

Purpose: convert a rough idea into a lightweight, high-level GitHub issue.

Behavior:

- Agent asks a small number of clarifying questions (typically 5–10).
- Agent drafts a concise issue with title, summary, acceptance criteria, out of scope, notes.
- Agent creates the issue via `gh issue create --body-file ...` and applies label `shipper:new`.

Output:

- A new GitHub issue labeled `shipper:new`.

## 2) `shipper groom <issue>`

Purpose: make the issue **decision-complete at the product level**.

Behavior:

- Agent reads the full issue and comments.
- Agent explores the codebase only to understand existing user-facing behavior (no design/architecture decisions).
- Agent interviews the product owner to resolve missing product decisions:
  - scope and requirements
  - UX/behavior including edge cases
  - acceptance criteria
  - follow-ups and boundaries

- Agent updates the issue body to be implementation-ready.
- Agent posts a grooming summary comment.
- Agent updates labels: add `shipper:groomed`, remove `shipper:new`.

If the agent recommends splitting:

- It creates additional issues using `gh issue create --body-file ... --label shipper:new`.
- Those new issues start in `shipper:new` status (not groomed).

Output:

- Updated original issue body + grooming summary comment.
- Issue labeled `shipper:groomed`.
- Optional: additional `shipper:new` issues created.

## 3) `shipper design <issue>`

Purpose: make the issue **decision-complete at the technical design level**.

Behavior:

- Agent reads the issue + grooming outputs.
- Agent explores the codebase to understand the current architecture and constraints.
- Agent produces a technical design write-up (as an issue comment), including tradeoffs and key decisions.
- If there are multiple viable approaches, it asks a small number of targeted questions.
- Agent updates labels: add `shipper:designed`, remove `shipper:groomed`.

Output:

- Design doc comment on the issue.
- Issue labeled `shipper:designed`.

## 4) `shipper plan <issue>`

Purpose: produce a detailed implementation plan with no open questions.

Behavior:

- Agent reads issue + design.
- Agent inspects the codebase and identifies specific files/areas to change.
- Agent writes an implementation plan comment: ordered steps, file touch list, test plan, risk notes.
- Agent updates labels: add `shipper:planned`, remove `shipper:designed`.

Output:

- Implementation plan comment.
- Issue labeled `shipper:planned`.

## 5) `shipper implement <issue>`

Purpose: implement the change on a new branch and push it.

Behavior:

- Shipper creates an ephemeral git worktree for the issue.
- Optional repo hooks run on worktree creation (install/build/etc).
- Agent implements according to the plan, runs checks, and fixes failures.
- Agent commits changes, pushes a branch to origin, and posts an implementation summary comment (branch name + notes).
- Shipper removes the worktree (ephemeral).
- Agent updates labels: add `shipper:implemented`, remove `shipper:planned`.

Output:

- Pushed branch.
- Implementation summary comment.
- Issue labeled `shipper:implemented`.

## 6) `shipper pr open <issue>`

Purpose: open a PR from the implemented branch.

Behavior:

- Shipper creates a fresh ephemeral worktree tracking the pushed branch.
- Agent runs quality checks, validates requirements, remediates if needed.
- Agent creates a PR via `gh pr create` with a clear body linking back to the issue.
- Shipper removes the worktree.

Output:

- PR opened (linked to issue).
- Issue labeled `shipper:pr-open`.

## 7) `shipper pr review <pr|issue>`

Purpose: create a first-pass review in GitHub review format.

Behavior:

- Agent reviews the PR diff against acceptance criteria and plan.
- Agent posts a GitHub review (approve or request changes) with actionable feedback.

Output:

- A GitHub PR review from Shipper.

## 8) `shipper pr remediate <pr|issue>`

Purpose: handle review feedback and prepare the PR for human merge.

Behavior:

- Shipper creates an ephemeral worktree on the PR branch.
- Agent pulls all PR reviews and comments.
- Agent converts review feedback into a structured list of claims/suggestions.
- Agent evaluates each item (accept/reject with rationale).
- Agent applies accepted changes, runs checks, and pushes updates.
- Agent replies to reviewers where appropriate.
- Shipper removes the worktree.
- Agent updates labels: add `shipper:ready`, remove `shipper:pr-open`.

Output:

- PR updated and checks passing.
- Reviewer replies posted.
- Issue labeled `shipper:ready` (ready for final human review + merge).

---

# Worktrees & hooks

Implementation and PR-affecting commands run in ephemeral worktrees that are created for the duration of the command and then deleted.

Repo-specific setup/cleanup can be added under `./.shipper/hooks/` and configured by `shipper init` (e.g. install deps on create, clean caches on destroy).

---

# Failure handling

If the agent discovers:

- missing prerequisites (`gh`, auth, labels) → instruct `shipper init` and stop.
- missing product decisions during later phases → recommend returning to `shipper groom`.
- missing technical decisions during implementation → recommend returning to `shipper design` / `shipper plan`.
- oversized scope → recommend splitting into additional issues (created in `shipper:new`).
