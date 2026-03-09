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

class PollingInterruptedError extends Error {
  constructor() {
    super('Check polling interrupted.');
  }
}

async function waitForChecks(pr: string, timeoutMinutes: number): Promise<void> {
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
    let checks = await fetchChecksGraceful(pr);
    if (checks !== null && checks.length === 0) {
      for (let retry = 0; retry < 3 && !interrupted; retry++) {
        if (Date.now() >= deadline) break;
        await sleepMs(10_000);
        if (interrupted) break;
        checks = await fetchChecksGraceful(pr);
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

      checks = await fetchChecksGraceful(pr);
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

      await sleepMs(20_000);
    }
  } finally {
    process.removeListener('SIGINT', sigHandler);
  }

  if (interrupted) {
    throw new PollingInterruptedError();
  }
}

async function fetchChecksGraceful(
  pr: string
): Promise<Awaited<ReturnType<typeof fetchChecks>> | null> {
  try {
    return await fetchChecks(pr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Failed to fetch CI checks: ${msg}`);
    return null;
  }
}

export async function prRemediateCommand(pr?: string): Promise<void> {
  let issueNumber: string;

  if (!pr) {
    const selected = await autoSelectPrForStage(
      'shipper:pr-reviewed',
      "No PRs ready for remediation. Run 'shipper pr review' first."
    );
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = await resolveRef(pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  const prRef = pr;
  if (!prRef) {
    console.error('Error: No PR selected for remediation.');
    process.exit(1);
  }

  const run = async () => {
    const branch = await getBranchForPR(prRef);

    return await withStageHooks('pr-remediate', { issueNumber, branchName: branch }, async () => {
      const { prReviewWait } = getSettings();

      if (prReviewWait.mode === 'timer') {
        if (prReviewWait.timeoutMinutes > 0) {
          const prJson = execFileSync('gh', ['pr', 'view', prRef, '--json', 'createdAt'], {
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
            await sleepMs(remainingMs);
          }
        }
      } else {
        await waitForChecks(prRef, prReviewWait.timeoutMinutes);
      }

      const repoRoot = await getRepoRoot();

      return await withWorktree(
        { repoRoot, branch, createBranch: false, issueNumber, stage: 'pr-remediate' },
        async (wtPath) => {
          return await runPrompt('pr_remediate', {
            issueRef: issueNumber,
            prRef,
            cwd: wtPath,
          });
        }
      );
    });
  };

  try {
    const code = await withIssueLock(issueNumber, run);
    process.exitCode = code;
  } catch (err) {
    if (err instanceof PollingInterruptedError) {
      process.exitCode = 130;
      return;
    }
    throw err;
  }
}
