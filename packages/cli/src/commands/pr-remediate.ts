import { execFileSync } from 'node:child_process';
import { getBranchForPR, getRepoRoot } from '@dnsquared/shipper-core';
import { fetchChecks, classifyChecks } from '@dnsquared/shipper-core';
import { autoSelectPrForStage, resolveRef } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';
import { getSettings } from '@dnsquared/shipper-core';

import { sleepMs } from '@dnsquared/shipper-core';

function waitForChecks(pr: string, timeoutMinutes: number): void {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let previousCompleted = -1;
  let interrupted = false;

  const sigHandler = () => {
    interrupted = true;
    console.log('\nCheck polling interrupted.');
  };
  process.on('SIGINT', sigHandler);

  try {
    // Zero-checks grace period: retry up to 3 times at 10s intervals
    let checks = fetchChecksGraceful(pr);
    if (checks !== null && checks.length === 0) {
      for (let retry = 0; retry < 3 && !interrupted; retry++) {
        if (Date.now() >= deadline) break;
        sleepMs(10_000);
        if (interrupted) break;
        checks = fetchChecksGraceful(pr);
        if (checks !== null && checks.length > 0) break;
      }
      if (!interrupted && (checks === null || checks.length === 0)) {
        console.log('No CI checks found. Proceeding.');
        return;
      }
    }

    // Main poll loop
    while (!interrupted) {
      if (Date.now() >= deadline) {
        console.log('Check polling timed out. Proceeding.');
        break;
      }

      checks = fetchChecksGraceful(pr);
      if (checks !== null) {
        const { pending, total } = classifyChecks(checks);
        const completed = total - pending.length;

        if (completed !== previousCompleted) {
          if (pending.length === 0) {
            console.log(`All checks complete. (${completed}/${total})`);
            break;
          }
          console.log(`Waiting for checks... ${completed}/${total} complete`);
          previousCompleted = completed;
        }
      }

      sleepMs(20_000);
    }
  } finally {
    process.removeListener('SIGINT', sigHandler);
  }

  if (interrupted) {
    process.exit(130);
  }
}

function fetchChecksGraceful(pr: string): ReturnType<typeof fetchChecks> | null {
  try {
    return fetchChecks(pr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Failed to fetch CI checks: ${msg}`);
    return null;
  }
}

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
    const branch = getBranchForPR(pr!);

    const code = withStageHooks('pr-remediate', { issueNumber, branchName: branch }, () => {
      const { prReviewWait } = getSettings();

      if (prReviewWait.mode === 'timer') {
        if (prReviewWait.timeoutMinutes > 0) {
          const prJson = execFileSync('gh', ['pr', 'view', pr!, '--json', 'createdAt'], {
            encoding: 'utf-8',
          });
          const { createdAt } = JSON.parse(prJson) as { createdAt: string };
          const elapsedMs = Date.now() - new Date(createdAt).getTime();
          const waitMs = prReviewWait.timeoutMinutes * 60_000;
          const remainingMs = waitMs - elapsedMs;

          if (remainingMs > 0) {
            const remainingMin = Math.ceil(remainingMs / 60_000);
            console.log(
              `PR #${pr} is ${Math.floor(elapsedMs / 60_000)} minutes old. ` +
                `Waiting ${remainingMin} more minute(s) for reviewers (prReviewWait.timeoutMinutes: ${prReviewWait.timeoutMinutes})...`
            );
            sleepMs(remainingMs);
          }
        }
      } else {
        waitForChecks(pr!, prReviewWait.timeoutMinutes);
      }

      const repoRoot = getRepoRoot();

      return withWorktree(
        { repoRoot, branch, createBranch: false, issueNumber, stage: 'pr-remediate' },
        (wtPath) => {
          return runPrompt('pr_remediate', { issueRef: issueNumber, prRef: pr, cwd: wtPath });
        }
      );
    });

    process.exit(code);
  };

  withIssueLock(issueNumber, run);
}
