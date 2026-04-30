---
title: Eject a prompt
description: Scaffold a bundled Shipper prompt into a repository-local editable override.
audience: agent
---

# Eject a prompt

Use `shipper eject` when a repository needs to customize the prompt Shipper sends to its configured
agent. Ejected prompts are committed under `.shipper/prompts/<agent>/`.

## Steps

1. Eject the default workflow prompt set.

   ```sh
   shipper eject
   ```

   This writes editable prompt files under `.shipper/prompts/<agent>/` for the repository's default
   agent.

2. Eject one workflow prompt by name.

   ```sh
   shipper eject pr-open
   ```

   Shipper maps CLI prompt names with hyphens to prompt filenames with underscores, so `pr-open`
   writes `.shipper/prompts/<agent>/pr_open.md`.

3. Eject the setup prompt explicitly when you need to override it.

   ```sh
   shipper eject setup
   ```

   `setup` is intentionally excluded from the default `shipper eject` set. Invoke
   `shipper eject setup` directly when a repository needs a local setup override.

4. Preserve the prompt resolution order.

   Shipper resolves `.shipper/prompts/<agent>/<name>.md` first. If that local override does not
   exist, Shipper falls back to the bundled prompt.

5. Check the CLI reference for command details.

   Use [Reference > CLI > shipper eject](../../reference/cli/eject/) for the generated command
   reference.

## Verification

Verify that the expected prompt override exists after ejecting it.

```sh
test -f .shipper/prompts/claude/pr_open.md
```
