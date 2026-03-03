import { findBranchForIssue, getRepoRoot } from '../lib/branch.js';
import { autoSelectIssue } from '../lib/github.js';
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
  }

  withIssueLock(issue, () => {
    const repoRoot = getRepoRoot();
    const branch = findBranchForIssue(issue);

    const code = withWorktree({ repoRoot, branch, createBranch: false }, (wtPath) => {
      return runPrompt('pr_open', { issueRef: issue, cwd: wtPath });
    });

    process.exit(code);
  });
}
