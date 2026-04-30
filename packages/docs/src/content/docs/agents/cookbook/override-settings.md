---
title: Override settings
description: Apply common Shipper settings overrides without republishing the full settings schema.
audience: agent
---

# Override settings

Edit `.shipper/settings.json` for committed repository defaults. Use
`.shipper/settings.local.json` for local-only overrides that should stay gitignored.

## Steps

1. Set the dependency install command.

   ```json
   {
     "installCommand": "npm install"
   }
   ```

2. Set the default base branch.

   ```json
   {
     "defaultBaseBranch": "main"
   }
   ```

3. Override MCP loading for individual stages.

   ```json
   {
     "commands": {
       "groom": { "disableMcp": true },
       "implement": { "disableMcp": false }
     }
   }
   ```

4. Set a default model for prompt-running commands.

   ```json
   {
     "commands": {
       "default": { "agent": "claude", "model": "opus" }
     }
   }
   ```

5. Add worktree environment variables.

   ```json
   {
     "worktreeEnv": {
       "UV_CACHE_DIR": ".shipper/tmp/.uv-cache"
     }
   }
   ```

6. Require passing checks before merge.

   ```json
   {
     "merge": {
       "requirePassingChecks": true
     }
   }
   ```

7. Put machine-local overrides in `.shipper/settings.local.json`.

   Shipper merges settings in this order: built-in defaults -> `.shipper/settings.json` ->
   `.shipper/settings.local.json`.

8. Keep the full schema in the reference.

   Use [Reference > Settings](/reference/settings/) for the complete settings table.

## Verification

Verify that `.shipper/settings.json` is still valid JSON after editing.

```sh
node -e "JSON.parse(require('node:fs').readFileSync('.shipper/settings.json', 'utf8'))"
```
