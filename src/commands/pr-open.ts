import { ensureInitialized } from '../lib/prerequisites.js';
import { findBranchForIssue, getRepoRoot } from '../lib/branch.js';
import { withWorktree } from '../lib/worktree.js';
import { runPrompt } from '../lib/prompt-runner.js';

export function prOpenCommand(issue: string) {
  if (!issue) {
    console.error('Error: Please provide an issue number or URL.');
    console.error('Usage: shipper pr open <issue>');
    process.exit(1);
  }

  ensureInitialized();

  const repoRoot = getRepoRoot();
  const branch = findBranchForIssue(issue);

  const code = withWorktree({ repoRoot, branch, createBranch: false }, (wtPath) => {
    return runPrompt('pr_open', { issueRef: issue, cwd: wtPath });
  });

  process.exit(code);
}
