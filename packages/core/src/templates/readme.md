# .shipper/

This folder is managed by [Shipper CLI](https://github.com/anthropics/shipper-cli), a workflow orchestrator that drives GitHub issues through a structured development lifecycle using AI-powered coding agents.

## Quick Start

1. **Create an issue from a request:**

   ```bash
   shipper new "Your feature idea or bug description"
   ```

2. **Advance the issue through each stage:**

   ```bash
   shipper next <issue-number>
   ```

   This runs the appropriate stage command automatically — grooming, design review, planning, implementation, PR creation, and so on.

## Folder Contents

| Path                  | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `prompts/`            | Prompt overrides created by `shipper eject` (committed to VCS)     |
| `hooks/`              | Executable hook scripts that run at stage boundaries and worktrees |
| `tmp/`                | Temporary working files (gitignored)                               |
| `settings.json`       | Team-wide settings (committed to VCS)                              |
| `settings.local.json` | Local overrides — not committed (gitignored)                       |
| `README.md`           | This file                                                          |

## Workflow Stages

Each issue progresses through these label-based stages:

```
shipper:new → shipper:groomed → shipper:designed → shipper:planned →
shipper:implemented → shipper:pr-open → shipper:pr-reviewed → shipper:ready
```

- **shipper:new** — Issue created, awaiting product grooming
- **shipper:groomed** — Product-groomed, awaiting design review
- **shipper:designed** — Design-reviewed, awaiting implementation planning
- **shipper:planned** — Implementation planned, ready for coding
- **shipper:implemented** — Code complete, awaiting PR creation
- **shipper:pr-open** — PR opened, awaiting review
- **shipper:pr-reviewed** — PR reviewed, pending remediation
- **shipper:ready** — Ready for final review and merge
- **shipper:blocked** — Blocked by a dependency (run `shipper unblock`)
- **shipper:locked** — Active shipper instance is working on this issue
- **shipper:failed** — Automated processing failed, requires investigation (run `shipper reset`)
- **shipper:priority-high** — Processed first in `ship --auto`
- **shipper:priority-low** — Processed last in `ship --auto`

Use `shipper next <issue>` to advance through stages, or run individual stage commands directly (e.g., `shipper groom <issue>`, `shipper design <issue>`).

## Customizing Prompts

Run `shipper eject` to scaffold editable prompt overrides. Existing overrides are left in place. `shipper init` does not modify prompt files.

## Settings

**`settings.json`** — Team-wide configuration, committed to version control:

- `prReviewWait` — PR review wait strategy (default: `{ "mode": "checks", "maxDurationMinutes": 30 }`). Use `{ "mode": "timer", "durationMinutes": N }` to wait a fixed number of minutes from PR creation time, or `{ "mode": "checks", "minDurationMinutes"?: N, "maxDurationMinutes"?: N }` to wait for CI with an optional minimum review window and optional maximum polling ceiling. Legacy `prReviewWaitMinutes`, timer-mode `timeoutMinutes`, and checks-mode `timeoutMinutes` values auto-migrate to the new shape.

**`settings.local.json`** — Local overrides that apply only to your machine. This file is gitignored and will not be committed. Any key set here takes precedence over `settings.json`.

## Hooks

Shipper supports executable hook scripts in `.shipper/hooks/`. Hook filenames determine when they run.

### Pre-stage hooks (blocking)

- `pre-groom`
- `pre-design`
- `pre-plan`
- `pre-implement`
- `pre-pr-open`
- `pre-pr-review`
- `pre-pr-remediate`
- `pre-merge`

These run before the corresponding stage. If a pre-hook exits non-zero, Shipper aborts that stage.

### Post-stage hooks (advisory)

- `post-groom`
- `post-design`
- `post-plan`
- `post-implement`
- `post-pr-open`
- `post-pr-review`
- `post-pr-remediate`
- `post-merge`

These run after the corresponding stage. If a post-hook exits non-zero, Shipper logs a warning and continues.

### Worktree lifecycle hooks (advisory)

- `worktree-setup`
- `worktree-teardown`

These run when Shipper creates or tears down a worktree. If a worktree hook exits non-zero, Shipper logs a warning and continues.

### Environment variables

Stage hooks receive:

- `SHIPPER_STAGE`
- `SHIPPER_ISSUE_NUMBER`
- `SHIPPER_BRANCH_NAME`

Worktree hooks receive the same variables plus:

- `SHIPPER_WORKTREE_PATH`

Hook scripts must be executable. Run `chmod +x .shipper/hooks/<hook-name>` after creating or updating a script.

## Further Help

- Run `shipper --help` to see all available commands
- See the project [README](https://github.com/anthropics/shipper-cli#readme) for full documentation
- [Open an issue](https://github.com/anthropics/shipper-cli/issues) to report bugs or request features
