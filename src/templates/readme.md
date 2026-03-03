# .shipper/

This folder is managed by [Shipper CLI](https://github.com/anthropics/shipper-cli), a workflow orchestrator that drives GitHub issues through a structured development lifecycle using AI-powered coding agents.

## Quick Start

1. **Create an issue from a pitch:**

   ```bash
   shipper new "Your feature idea or bug description"
   ```

2. **Advance the issue through each stage:**

   ```bash
   shipper next <issue-number>
   ```

   This runs the appropriate stage command automatically — grooming, design review, planning, implementation, PR creation, and so on.

## Folder Contents

| Path                   | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `prompts/`             | Markdown prompt files used by each stage command (committed to VCS) |
| `hooks/`               | Reserved for future hook scripts                                   |
| `tmp/`                 | Temporary working files (gitignored)                               |
| `settings.json`        | Team-wide settings (committed to VCS)                              |
| `settings.local.json`  | Local overrides — not committed (gitignored)                       |
| `README.md`            | This file                                                          |

## Workflow Stages

Each issue progresses through these label-based stages:

```
shipper:new → shipper:groomed → shipper:designed → shipper:planned
→ shipper:implemented → shipper:pr-open → shipper:pr-reviewed → shipper:ready
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

Use `shipper next <issue>` to advance through stages, or run individual stage commands directly (e.g., `shipper groom <issue>`, `shipper design <issue>`).

## Customizing Prompts

Each stage command uses a Markdown prompt file from `prompts/`. To customize a stage's behavior, edit the corresponding `.md` file directly. Changes take effect the next time that stage runs.

Running `shipper init` again will overwrite prompt files with the latest defaults. To preserve customizations, consider committing your changes before re-initializing.

## Settings

**`settings.json`** — Team-wide configuration, committed to version control:

- `prReviewWaitMinutes` — Minimum wait time (minutes) before PR review remediation (default: `15`)
- `hooks.postMerge` — Shell command to run after a PR is merged

**`settings.local.json`** — Local overrides that apply only to your machine. This file is gitignored and will not be committed. Any key set here takes precedence over `settings.json`.

## Hooks

Shipper supports a `postMerge` hook that runs a shell command after a PR is merged. Configure it in `settings.json`:

```json
{
  "hooks": {
    "postMerge": "echo 'PR merged!'"
  }
}
```

The following environment variables are available to hook commands:

- `SHIPPER_PR_NUMBER` — The merged PR number
- `SHIPPER_ISSUE_NUMBER` — The associated issue number
- `SHIPPER_BRANCH_NAME` — The branch that was merged

## Further Help

- Run `shipper --help` to see all available commands
- See the project [README](https://github.com/anthropics/shipper-cli#readme) for full documentation
- [Open an issue](https://github.com/anthropics/shipper-cli/issues) to report bugs or request features
