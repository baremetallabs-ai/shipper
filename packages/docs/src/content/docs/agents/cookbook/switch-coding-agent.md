---
title: Switch coding agents
description: Change the default or per-stage coding agent Shipper uses for prompt-running commands.
audience: agent
---

# Switch coding agents

Change the agent Shipper uses globally or for a specific prompt-running stage. Use
`.shipper/settings.json` for committed repository defaults.

## Steps

1. Set the default coding agent.

   Edit `.shipper/settings.json` and set `commands.default.agent`. The only valid values are
   `"claude"`, `"codex"`, and `"copilot"`.

   ```json
   {
     "commands": {
       "default": {
         "agent": "codex"
       }
     }
   }
   ```

2. Override individual stages when needed.

   Add entries under `commands` for the stages that should use a different agent. Use underscore
   keys for PR commands.

   ```json
   {
     "commands": {
       "default": { "agent": "claude" },
       "implement": { "agent": "codex" },
       "pr_review": { "agent": "copilot" },
       "setup": { "agent": "codex" }
     }
   }
   ```

3. Use only supported stage keys.

   Valid per-step override keys are `new`, `groom`, `design`, `plan`, `implement`, `pr_open`,
   `pr_review`, `pr_remediate`, `unblock`, and `setup`.

4. Check the reference when you need more settings fields.

   Use [Reference > Settings](/reference/settings/) for the full settings schema and
   [Reference > CLI](/reference/cli/) for command details.

## Verification

Verify that `.shipper/settings.json` is still valid JSON after editing.

```sh
node -e "JSON.parse(require('node:fs').readFileSync('.shipper/settings.json', 'utf8'))"
```
