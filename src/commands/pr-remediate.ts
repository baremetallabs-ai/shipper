import { execFileSync } from 'node:child_process';
import { getBranchForPR, getRepoRoot } from '../lib/branch.js';
import { selectIssuesForStage, tryResolvePrForIssue } from '../lib/github.js';
import { withWorktree } from '../lib/worktree.js';
import { runPrompt } from '../lib/prompt-runner.js';
import { getSettings } from '../lib/settings.js';

export function prRemediateCommand(pr?: string) {
  if (!pr) {
    const issues = selectIssuesForStage('shipper:pr-reviewed');
    let resolved: string | undefined;
    let resolvedIssue: { number: number; title: string } | undefined;
    for (const issue of issues) {
      resolved = tryResolvePrForIssue(issue.number);
      if (resolved) {
        resolvedIssue = issue;
        break;
      }
    }
    if (!resolved || !resolvedIssue) {
      console.error("No PRs ready for remediation. Run 'shipper pr review' first.");
      process.exit(1);
    }
    console.error(
      `Auto-selected PR #${resolved} (issue #${resolvedIssue.number}: ${resolvedIssue.title})`
    );
    pr = resolved;
  }

  const waitMinutes = getSettings().prReviewWaitMinutes;
  if (waitMinutes > 0) {
    const prJson = execFileSync('gh', ['pr', 'view', pr, '--json', 'createdAt'], {
      encoding: 'utf-8',
    });
    const { createdAt } = JSON.parse(prJson) as { createdAt: string };
    const elapsedMs = Date.now() - new Date(createdAt).getTime();
    const waitMs = waitMinutes * 60_000;
    const remainingMs = waitMs - elapsedMs;

    if (remainingMs > 0) {
      const remainingMin = Math.ceil(remainingMs / 60_000);
      console.log(
        `PR #${pr} is ${Math.floor(elapsedMs / 60_000)} minutes old. ` +
          `Waiting ${remainingMin} more minute(s) for reviewers (prReviewWaitMinutes: ${waitMinutes})...`
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remainingMs);
    }
  }

  const repoRoot = getRepoRoot();
  const branch = getBranchForPR(pr);

  const code = withWorktree({ repoRoot, branch, createBranch: false }, (wtPath) => {
    return runPrompt('pr_remediate', { issueRef: pr, prRef: pr, cwd: wtPath });
  });

  process.exit(code);
}
