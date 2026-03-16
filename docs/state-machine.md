# Label-Based State Machine

Shipper uses GitHub issue labels as the sole representation of workflow state. Each issue carries exactly one `shipper:*` workflow label at a time, plus zero or more control labels.

## Labels

### Workflow labels

| Label                 | Description                             |
| --------------------- | --------------------------------------- |
| `shipper:new`         | New issue, awaiting grooming            |
| `shipper:groomed`     | Product-groomed, awaiting design        |
| `shipper:designed`    | Design-reviewed, awaiting planning      |
| `shipper:planned`     | Implementation planned, awaiting coding |
| `shipper:implemented` | Implementation complete, awaiting PR    |
| `shipper:pr-open`     | PR opened, awaiting review              |
| `shipper:pr-reviewed` | PR reviewed, awaiting remediation       |
| `shipper:ready`       | Ready for final review and merge        |

### Control labels

| Label             | Description                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `shipper:blocked` | Issue has unmet dependencies. Prevents advancement (except `new` -> `groomed`).               |
| `shipper:locked`  | Active shipper instance is working on this issue. Prevents concurrent access.                 |
| `shipper:failed`  | Automated processing failed. Blocks `next`, excluded from auto-selection, cleared by `reset`. |

### Priority labels

| Label                   | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `shipper:priority-high` | High-priority issue. Processed first within each stage in auto-ship. |
| `shipper:priority-low`  | Low-priority issue. Processed last within each stage in auto-ship.   |

Normal priority is the default when neither label is present.

## State transitions

```
shipper:new
  |  groom
  v
shipper:groomed
  |  design
  v
shipper:designed
  |  plan
  v
shipper:planned
  |  implement
  v
shipper:implemented
  |  pr-open
  v
shipper:pr-open
  |  pr-review
  v
shipper:pr-reviewed <--+
  |  pr-remediate      |  review loop (max 3 tight cycles)
  +--------------------+
  |
  v
shipper:ready
  |  merge
  v
[issue closed]
```

### How transitions happen

Labels are transitioned by the coding agent, not by command code directly. Each prompt instructs the agent to run `gh issue edit` with `--add-label` and `--remove-label` in a single atomic call. For example, after a successful groom:

```
gh issue edit <ISSUE> --add-label "shipper:groomed" --remove-label "shipper:new"
```

### Rollback paths

Agents can roll back to an earlier stage if the work is insufficient:

| Stage        | Can roll back to                        |
| ------------ | --------------------------------------- |
| design       | `shipper:new`                           |
| plan         | `shipper:groomed` or `shipper:new`      |
| implement    | `shipper:designed` or `shipper:groomed` |
| pr-open      | `shipper:planned`                       |
| pr-remediate | `shipper:planned`                       |

## The `next` command

Auto-advances an issue by reading its current label and dispatching to the corresponding command. Validates that exactly one workflow label is present, rejects issues marked `shipper:failed`, and refuses blocked issues except `shipper:new`, which can always be groomed.

## The `ship --auto` command

Processes issues in priority order, advancing the most-complete issues first:

```
shipper:ready > shipper:pr-reviewed > shipper:pr-open > shipper:implemented
> shipper:planned > shipper:designed > shipper:groomed
```

`shipper:new` is excluded from auto-ship because grooming is interactive by default.

Within each stage, issues are ordered by priority: `shipper:priority-high` first, then normal priority, then `shipper:priority-low`. Within the same priority tier, issues are processed FIFO by label-application timestamp queried via the GitHub timeline API.

After exhausting available issues, auto-ship attempts to unblock `shipper:blocked` issues. If any are unblocked, it loops back to process the newly available issues.

A review cycle cap (`MAX_REVIEW_CYCLES = 3`) prevents infinite tight `pr-reviewed <-> pr-remediate` loops.

## The `reset` command

`reset` only moves an issue backward to an earlier workflow stage.

- Without `--to`, it presents an interactive picker of valid earlier targets.
- With `--to <stage>`, it resets directly to the specified earlier stage.
- Valid reset targets are `new`, `groomed`, `designed`, `planned`, and `implemented`, as long as the target is behind the current stage.
- Reset removes later shipper labels, closes matching open PRs, and for any closed PR whose head ref starts with `shipper/` attempts to delete that remote branch; it also removes matching local branches and local worktrees, deletes later-stage issue comments, and posts a reset notice comment after re-applying the target label.
- Reset always removes `shipper:failed`.
- Reset preserves `shipper:priority-high` and `shipper:priority-low`.

## Locking

The `shipper:locked` label prevents concurrent execution on the same issue.

- **Acquire:** Adds the label. If it is already present and stale according to `lockTimeoutMinutes` (default `30` minutes), Shipper clears and reacquires it. If the lock is still fresh, the command errors out.
- **Heartbeat:** Renews the lock every `lockTimeoutMinutes / 3` minutes. With the default timeout, that is every 10 minutes.
- **Release:** Removes the label in a `finally` block after command completion. Signal handlers (`SIGINT` and `SIGTERM`) also release the lock.
- **Staleness detection:** Queries the issue timeline API for the most recent `labeled` event for `shipper:locked` and compares its age to the configured timeout.

All workflow commands wrap their execution in `withIssueLock()`.

## Blocking

`shipper:blocked` indicates an issue has unmet dependencies. It is typically set by the agent during grooming when dependencies are discovered.

- The `next` command refuses to advance blocked issues, except `shipper:new`.
- `selectIssuesForStage()` excludes blocked issues from auto-selection, except for `shipper:new`.
- The `unblock` command prompts an agent to re-check dependencies and remove the label if resolved.

## Key files

| File                                      | Role                                            |
| ----------------------------------------- | ----------------------------------------------- |
| `packages/core/src/lib/labels.ts`         | Label definitions (names, colors, descriptions) |
| `packages/cli/src/commands/next.ts`       | State machine dispatch                          |
| `packages/cli/src/commands/ship.ts`       | Auto-ship priority ordering and stage names     |
| `packages/cli/src/commands/reset.ts`      | Stage categorization and cleanup for reset      |
| `packages/cli/src/commands/issue-list.ts` | Label display and grouping                      |
| `packages/core/src/lib/lock.ts`           | Lock acquire, release, heartbeat, and staleness |
| `packages/core/src/lib/github.ts`         | Issue selection and label timeline queries      |
| `packages/core/src/lib/prerequisites.ts`  | Label existence validation                      |
