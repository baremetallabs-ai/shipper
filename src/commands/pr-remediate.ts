import { getBranchForPR, getRepoRoot } from '../lib/branch.js';
import { withWorktree } from '../lib/worktree.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function prRemediateCommand(pr: string) {
  if (!pr) {
    console.error('Error: Please provide a PR number or URL.');
    console.error('Usage: shipper pr remediate <pr>');
    process.exit(1);
  }

  const repoRoot = getRepoRoot();
  const branch = getBranchForPR(pr);

  const code = withWorktree({ repoRoot, branch, createBranch: false }, (wtPath) => {
    return runPrompt('pr_remediate', { issueRef: pr, prRef: pr, cwd: wtPath });
  });

  process.exit(code);
}
