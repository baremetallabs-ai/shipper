---
title: Configure hooks
description: Add executable scripts that run before or after Shipper stages and worktree lifecycle events.
audience: agent
---

# Configure hooks

Add hooks when a repository needs local automation around Shipper stages. Hooks are executable files
under `.shipper/hooks/`.

## Steps

1. Choose the hook filename.

   Supported filenames are:
   - `pre-<stage>`
   - `post-<stage>`
   - `worktree-setup`
   - `worktree-teardown`

2. Use pre-stage hooks for blocking checks.

   A `pre-<stage>` hook aborts the stage when it exits non-zero. Use this for required local checks
   that must pass before an agent starts work.

3. Use post-stage and worktree lifecycle hooks for advisory automation.

   A `post-<stage>` hook warns on failure and lets the stage result continue. `worktree-setup` and
   `worktree-teardown` also warn on failure and continue.

4. Configure the hard timeout when needed.

   Shipper enforces `hookTimeoutMinutes` from `.shipper/settings.json`, with local overrides from
   `.shipper/settings.local.json`. The default is `10` minutes. Set it to `0` to disable hook
   timeout enforcement.

   When a timeout fires, `pre-<stage>`, `worktree-setup`, and the worktree dependency install
   command abort the run or worktree creation. `post-<stage>` and `worktree-teardown` warn and
   continue.

5. Create an executable hook.

   ```sh
   mkdir -p .shipper/hooks
   printf '%s\n' '#!/usr/bin/env sh' 'npm run format:check' > .shipper/hooks/pre-implement
   chmod +x .shipper/hooks/pre-implement
   ```

6. Read hook context from environment variables.

   Use the [Hook context](/reference/environment-variables/#hook-context) reference to read the
   values Shipper provides to stage and worktree hook scripts.

7. Check related reference material.

   Use [Reference > MCP](/reference/mcp/) for agent tool details and
   [Reference > CLI](/reference/cli/) for command details.

## Verification

Verify that the hook exists and is executable.

```sh
test -x .shipper/hooks/pre-implement
```
