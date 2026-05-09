---
title: Configure hooks
description: Add executable scripts that run before or after Shipper stages and worktree lifecycle events.
audience: agent
---

# Configure hooks

Add hooks when a repository needs local automation around Shipper stages. Hooks are executable files
under `.shipper/hooks/`.

## Steps

1. Choose one supported hook filename from [Reference > Hooks](/reference/hooks/).

   This recipe uses `pre-implement`.

2. Create the script under `.shipper/hooks/pre-implement`.

   ```sh
   mkdir -p .shipper/hooks
   printf '%s\n' '#!/usr/bin/env sh' 'npm run format:check' > .shipper/hooks/pre-implement
   ```

3. Make the hook executable.

   ```sh
   chmod +x .shipper/hooks/pre-implement
   ```

4. Verify that the hook exists and is executable.

   ```sh
   test -x .shipper/hooks/pre-implement
   ```

Use [Reference > Hooks](/reference/hooks/) for supported filenames, environment variables, exit
behavior, timeout behavior, cancellation, and worktree lifecycle details.
