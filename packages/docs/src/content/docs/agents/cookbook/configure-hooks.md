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

4. Create an executable hook.

   ```sh
   mkdir -p .shipper/hooks
   printf '%s\n' '#!/usr/bin/env sh' 'npm run format:check' > .shipper/hooks/pre-implement
   chmod +x .shipper/hooks/pre-implement
   ```

5. Read hook context from environment variables.

   Stage hooks receive:
   - `SHIPPER_STAGE`
   - `SHIPPER_ISSUE_NUMBER`
   - `SHIPPER_BRANCH_NAME`

   Worktree hooks also receive:
   - `SHIPPER_WORKTREE_PATH`

6. Check related reference material.

   Use [Reference > MCP](../../reference/mcp/) for agent tool details and
   [Reference > CLI](../../reference/cli/) for command details.

## Verification

Verify that the hook exists and is executable.

```sh
test -x .shipper/hooks/pre-implement
```
