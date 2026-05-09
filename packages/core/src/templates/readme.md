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

   This runs the appropriate stage command automatically: grooming, design review, planning,
   implementation, PR creation, review, remediation, and merge readiness.

## Directory reference

For the canonical reference covering each `.shipper/` entry, how it is created, how it is used, and
whether it is committed or ignored, see:

https://shipper.baremetallabs.ai/reference/shipper-directory/

## Workflow orientation

Each issue progresses through Shipper's label-based workflow:

```text
shipper:new -> shipper:groomed -> shipper:designed -> shipper:planned ->
shipper:implemented -> shipper:pr-open -> shipper:pr-reviewed -> shipper:ready
```

See the state-machine reference for label definitions, transition behavior, locking, blocking,
reset, and auto-ship ordering:

https://shipper.baremetallabs.ai/concepts/state-machine/

## Common references

- `.shipper directory`: https://shipper.baremetallabs.ai/reference/shipper-directory/
- Settings: https://shipper.baremetallabs.ai/reference/settings/
- Configure hooks: https://shipper.baremetallabs.ai/agents/cookbook/configure-hooks/
- Eject a prompt: https://shipper.baremetallabs.ai/agents/cookbook/eject-prompt/
- CLI reference: https://shipper.baremetallabs.ai/reference/cli/
- State machine: https://shipper.baremetallabs.ai/concepts/state-machine/

## Further Help

- Run `shipper --help` to see all available commands.
- See the full documentation: https://shipper.baremetallabs.ai
- [Open an issue](https://github.com/baremetallabs-ai/shipper/issues) to report bugs or request
  features.
