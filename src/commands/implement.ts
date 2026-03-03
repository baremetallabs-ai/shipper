import { generateBranchName, getRepoRoot } from '../lib/branch.js';
import { withWorktree } from '../lib/worktree.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function implementCommand(issue: string) {
  if (!issue) {
    console.error('Error: Please provide an issue number or URL.');
    console.error('Usage: shipper implement <issue>');
    process.exit(1);
  }

  const repoRoot = getRepoRoot();
  const branch = generateBranchName(issue);

  const code = withWorktree({ repoRoot, branch, createBranch: true }, (wtPath) => {
    return runPrompt('implement', { issueRef: issue, cwd: wtPath });
  });

  process.exit(code);
}
