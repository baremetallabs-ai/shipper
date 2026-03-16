---
name: review-audit
description: Audit the effectiveness of our PR review step by comparing it against external reviewers across recent issues
argument-hint: '[number-of-issues]'
---

Audit the shipper review step across the $ARGUMENTS most recent closed or merged issues that have associated PRs. Default to 10 if no number is given.

## Process

### 1. Gather data

Fetch the N most recent issues (closed/merged preferred, open with PRs acceptable) and identify their linked PRs. For each PR, collect the full text of:

- All issue comments (these contain agent stage outputs and agent feedback)
- All PR review submissions (state, author, body)
- All inline PR review comments (author, file, line, body)
- All PR conversation comments

Fetch this data in parallel. Use `gh issue view`, `gh pr view`, and `gh api repos/{owner}/{repo}/pulls/{number}/reviews` and `.../comments` as needed. Collect everything before analyzing anything.

### 2. Aggregate agent feedback

Scan the issue comments for operational feedback the agent left about its own process. These typically appear at the end of implementation or remediation summaries under headings like "Agent Feedback" or "Notes." Deduplicate entries that report the same underlying issue across multiple issues and note how many times each recurred.

### 3. Compare review effectiveness

For each PR, identify every finding raised by every reviewer. Classify each finding as one of:

- **Bug** — a correctness, data-flow, behavioral, or accessibility defect that would cause wrong behavior at runtime
- **Improvement** — a valid simplification, cleanup, or UX enhancement that does not fix a bug
- **Style** — formatting, naming, or structural preference with no behavioral impact
- **False positive** — a suggestion that contradicts the explicit design or is factually incorrect

Build a table per PR showing which reviewer caught which finding, then roll up into a summary scorecard across all PRs. Track bugs separately from other categories — bug detection rate is the primary metric.

### 4. Identify patterns

Look for recurring themes:

- Classes of bugs our review step consistently misses (e.g., data-flow gaps, edge cases, accessibility)
- Whether external reviewers tend to find the same bugs independently (signal that the bug was surface-level)
- Whether remediation successfully addressed all external findings
- Any false positive patterns from external reviewers worth noting

### 5. Produce output

Present the results as:

1. **Agent feedback summary** — deduplicated list with recurrence counts and affected issues
2. **Per-PR findings table** — every finding, its category, and which reviewers caught or missed it
3. **Scorecard** — bugs caught per reviewer, improvements, false positives
4. **Pattern analysis** — what our review step is systematically missing and why
5. **Recommendations** — concrete, actionable items written as single-paragraph requests suitable for feeding to an agent

Keep the output direct. Lead with the scorecard and patterns, then provide the detailed tables as supporting evidence.
