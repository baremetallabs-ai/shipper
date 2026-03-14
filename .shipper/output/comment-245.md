## Implementation Summary

**Branch:** `shipper/245-feat-prompts-add-opt-in-agent-feedback-section-to`

### Changes made

- Added the shared opt-in `## Agent Feedback` instruction block to the `groom`, `design`, `plan`, `implement`, `pr_open`, `pr_review`, `pr_remediate`, and `unblock` prompts under both `packages/core/src/prompts/claude` and `packages/core/src/prompts/codex`.
- Kept the block wording aligned across all 16 in-scope files, changing only the stage-specific comment target phrase required by each prompt.
- Left `packages/core/src/prompts/{claude,codex}/new.md` and `packages/core/src/prompts/{claude,codex}/setup.md` unchanged.

### Verification

- `npm run lint`
- `npm run format:check`
- `npm run type-check`
- `npm run build`
- `npm run test`
- Confirmed all 16 in-scope prompt files contain exactly one `## Agent Feedback` section in the planned insertion point.
- Confirmed every inserted block uses the exact heading, says the section is appended as the very last section of the relevant comment or PR body, and omits the section entirely when there is nothing to report.
- Confirmed every inserted block includes all five reportable feedback categories from the plan.
- Confirmed both `pr_review` prompts direct feedback to the issue comment posted via `gh issue comment`, not the PR review body.
- Confirmed `new.md` and `setup.md` in both prompt variants remain unchanged and contain no `## Agent Feedback` section.

### Notes

- No deviations from the accepted plan were required.
