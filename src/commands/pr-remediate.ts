import { execFileSync } from 'node:child_process';
import { getBranchForPR, getRepoRoot } from '../lib/branch.js';
import { autoSelectPrForStage, resolveRef } from '../lib/github.js';
import { withIssueLock } from '../lib/lock.js';
import { withWorktree } from '../lib/worktree.js';
import { runPrompt } from '../lib/prompt-runner.js';
import { getSettings } from '../lib/settings.js';

export function prRemediateCommand(pr?: string) {
  let issueNumber: string;

  if (!pr) {
    const selected = autoSelectPrForStage(
      'shipper:pr-reviewed',
      "No PRs ready for remediation. Run 'shipper pr review' first."
    );
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = resolveRef(pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  const run = () => {
    const waitMinutes = getSettings().prReviewWaitMinutes;
    if (waitMinutes > 0) {
      const prJson = execFileSync('gh', ['pr', 'view', pr!, '--json', 'createdAt'], {
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
    const branch = getBranchForPR(pr!);

    const code = withWorktree({ repoRoot, branch, createBranch: false, issueNumber }, (wtPath) => {
      return runPrompt('pr_remediate', { issueRef: pr, prRef: pr, cwd: wtPath });
    });

    process.exit(code);
  };

  withIssueLock(issueNumber, run);
}
