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

5. Migrate old `new` prompt overrides before running them.

   Local `.shipper/prompts/<agent>/new.md` overrides written for the old issue-creation contract are
   out of date if they run `gh issue create`, write `.shipper/tmp/issue-<timestamp>.md`, or emit
   `created_issue` directly. Shipper now owns GitHub issue creation and `shipper:new` label
   application. A migrated `new` override must write `.shipper/output/result.json` with
   `issue_draft`, plus `.shipper/output/issue-draft.json` and `.shipper/output/issue-body.md`.
   The fastest migration path is to run `shipper eject new` again and then reapply local copy edits.

6. Check the CLI reference for command details.

   Use [Reference > CLI > shipper eject](/reference/cli/eject/) for the generated command
   reference.

## Verification

Verify that the expected prompt override exists after ejecting it.

```sh
AGENT=$(node -p "JSON.parse(require('node:fs').readFileSync('.shipper/settings.json', 'utf8')).commands?.default?.agent ?? 'claude'")
test -f ".shipper/prompts/${AGENT}/pr_open.md"
```
