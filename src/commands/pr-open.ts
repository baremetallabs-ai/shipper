import { findBranchForIssue, getRepoRoot } from '../lib/branch.js';
import { autoSelectIssue, resolveBaseBranch, resolveRef } from '../lib/github.js';
import { withStageHooks } from '../lib/hooks.js';
import { getSettings } from '../lib/settings.js';
import { withIssueLock } from '../lib/lock.js';
import { withWorktree } from '../lib/worktree.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function prOpenCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:implemented');
    if (!selected) {
      console.error("No issues ready for PR. Run 'shipper implement' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  } else {
    const resolved = resolveRef(issue, 'issue');
    issue = resolved.issueNumber;
  }

  const settings = getSettings();
  const baseBranch = resolveBaseBranch(settings.defaultBaseBranch);

  withIssueLock(issue, () => {
    const repoRoot = getRepoRoot();
    const branch = findBranchForIssue(issue);

    const code = withStageHooks('pr-open', { issueNumber: issue, branchName: branch }, () =>
      withWorktree({ repoRoot, branch, createBranch: false, issueNumber: issue }, (wtPath) => {
        return runPrompt('pr_open', { issueRef: issue, cwd: wtPath, baseBranch });
      })
    );

    process.exit(code);
  });
}
