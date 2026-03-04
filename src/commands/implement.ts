import { generateBranchName, getRepoRoot } from '../lib/branch.js';
import { autoSelectIssue } from '../lib/github.js';
import { withStageHooks } from '../lib/hooks.js';
import { withIssueLock } from '../lib/lock.js';
import { withWorktree } from '../lib/worktree.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function implementCommand(issue?: string) {
  if (!issue) {
    const selected = autoSelectIssue('shipper:planned');
    if (!selected) {
      console.error("No issues ready for implementation. Run 'shipper plan' first.");
      process.exit(1);
    }
    console.error(`Auto-selected #${selected.number}: ${selected.title}`);
    issue = String(selected.number);
  }

  withIssueLock(issue, () => {
    const repoRoot = getRepoRoot();
    const branch = generateBranchName(issue);

    const code = withStageHooks('implement', { issueNumber: issue, branchName: branch }, () =>
      withWorktree({ repoRoot, branch, createBranch: true, issueNumber: issue }, (wtPath) => {
        return runPrompt('implement', { issueRef: issue, cwd: wtPath });
      })
    );

    process.exit(code);
  });
}
