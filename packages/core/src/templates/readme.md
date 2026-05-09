# .shipper/

This folder is managed by [Shipper CLI](https://github.com/baremetallabs-ai/shipper), a workflow
orchestrator that drives GitHub issues through a structured development lifecycle using AI-powered
coding agents.

## Quick Start

1. **Create an issue from a request:**

   ```bash
   shipper new "Your feature idea or bug description"
   ```

2. **Advance the issue through each stage:**

   ```bash
   shipper next <issue-number>
   ```

   This dispatches the next command for the issue's current label: `shipper groom`,
   `shipper design`, `shipper plan`, `shipper implement`, `shipper pr open`,
   `shipper pr review`, or `shipper pr remediate`.

## Directory reference

For the canonical reference covering each `.shipper/` entry, how it is created, how it is used, and
whether it is committed or ignored, see:

https://shipper.baremetallabs.ai/reference/shipper-directory/

## Hooks

Hook scripts live in `.shipper/hooks/`.

Pre-stage hooks: `pre-new`, `pre-groom`, `pre-design`, `pre-plan`, `pre-implement`,
`pre-pr-open`, `pre-pr-review`, `pre-pr-remediate`, `pre-merge`.
Post-stage hooks: `post-new`, `post-groom`, `post-design`, `post-plan`, `post-implement`,
`post-pr-open`, `post-pr-review`, `post-pr-remediate`, `post-merge`.
Worktree lifecycle hooks: `worktree-setup`, `worktree-teardown`.

Hooks reference: https://shipper.baremetallabs.ai/reference/hooks/

## Workflow orientation

Each issue progresses through Shipper's label-based workflow:

```text
shipper:new -> shipper:groomed -> shipper:designed -> shipper:planned ->
shipper:implemented -> shipper:pr-open -> shipper:pr-reviewed -> shipper:ready
```

`shipper pr remediate` runs while the issue is labeled `shipper:pr-reviewed`. When remediation
accepts, Shipper advances the issue and pull request to `shipper:ready`; there is no separate
`shipper:remediation` label.

See the state-machine reference for label definitions, transition behavior, locking, blocking,
reset, and auto-ship ordering:

https://shipper.baremetallabs.ai/concepts/state-machine/

## Common references

- `.shipper directory`: https://shipper.baremetallabs.ai/reference/shipper-directory/
- Settings: https://shipper.baremetallabs.ai/reference/settings/
- Hooks: https://shipper.baremetallabs.ai/reference/hooks/
- Eject a prompt: https://shipper.baremetallabs.ai/agents/cookbook/eject-prompt/
- CLI reference: https://shipper.baremetallabs.ai/reference/cli/
- State machine: https://shipper.baremetallabs.ai/concepts/state-machine/

## Further Help

- Run `shipper --help` to see all available commands.
- See the full documentation: https://shipper.baremetallabs.ai
- [Open an issue](https://github.com/baremetallabs-ai/shipper/issues) to report bugs or request
  features.
