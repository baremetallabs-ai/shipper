# .shipper/

This folder is managed by [Shipper CLI](https://github.com/baremetallabs-ai/shipper), a workflow orchestrator that drives GitHub issues through a structured development lifecycle using AI-powered coding agents.

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

Each issue progresses through Shipper's label-based workflow:

```
shipper:new → shipper:groomed → shipper:designed → shipper:planned →
shipper:implemented → shipper:pr-open → shipper:pr-reviewed → shipper:ready
```

See the state-machine reference for label definitions, transition behavior, locking, blocking, reset,
and auto-ship ordering:

https://shipper.baremetallabs.ai/concepts/state-machine/

## Customizing Prompts

Run `shipper eject` to scaffold editable prompt overrides. Existing overrides are left in place. `shipper init` does not modify prompt files.

## Settings

**`settings.json`** — Team-wide configuration, committed to version control:

**`settings.local.json`** — Local overrides that apply only to your machine. This file is gitignored and will not be committed. Any key set here takes precedence over `settings.json`.

See the settings reference for supported keys, defaults, and precedence:

https://shipper.baremetallabs.ai/reference/settings/

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
- See the CLI reference: https://shipper.baremetallabs.ai/reference/cli/
- See the full documentation: https://shipper.baremetallabs.ai
- [Open an issue](https://github.com/baremetallabs-ai/shipper/issues) to report bugs or request features
