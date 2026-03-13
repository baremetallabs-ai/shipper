import { getBranchForPR, getRepoRoot } from '@dnsquared/shipper-core';
import { fetchChecks, classifyChecks } from '@dnsquared/shipper-core';
import { autoSelectPrForStage, resolveRef } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { formatConflictContext } from '@dnsquared/shipper-core';
import { gh } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withGitTransport } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';
import { getSettings } from '@dnsquared/shipper-core';
import type { PrReviewWait } from '@dnsquared/shipper-core';

import { sleepMs } from '@dnsquared/shipper-core';

const ZERO_CHECKS_GRACE_MS = 30_000;
export const SKIP_PR_REMEDIATE_WAIT_ENV_VAR = 'SHIPPER_SKIP_PR_REMEDIATE_WAIT';

class PollingInterruptedError extends Error {
  constructor() {
    super('Check polling interrupted.');
  }
}

async function waitForChecks(repo: string, pr: string, timeoutMinutes: number): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let previousCompleted = -1;
  let interrupted = false;
  let proceedWithoutChecks = false;
  const isInterrupted = () => interrupted;

  const sigHandler = () => {
    interrupted = true;
    console.log('\nCheck polling interrupted.');
  };
  process.on('SIGINT', sigHandler);

  try {
    // Zero-checks grace period: retry up to 3 times at 10s intervals
    let checks = await fetchChecksGraceful(repo, pr);
    if (checks?.length === 0) {
      for (let retry = 0; retry < 3; retry++) {
        if (isInterrupted() || Date.now() >= deadline) break;
        await sleepMs(10_000);
        checks = await fetchChecksGraceful(repo, pr);
        if (checks === null || checks.length === 0) continue;
        break;
      }
      if (checks === null || checks.length === 0) {
        proceedWithoutChecks = true;
      }
    }

    // Main poll loop
    for (; !proceedWithoutChecks; ) {
      if (isInterrupted()) {
        break;
      }

      if (Date.now() >= deadline) {
        console.log('Check polling timed out. Proceeding.');
        break;
      }

      checks = await fetchChecksGraceful(repo, pr);
      if (checks) {
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

  if (isInterrupted()) {
    throw new PollingInterruptedError();
  }

  if (proceedWithoutChecks) {
    console.log('No CI checks found. Proceeding.');
  }
}

async function fetchChecksGraceful(
  repo: string,
  pr: string
): Promise<Awaited<ReturnType<typeof fetchChecks>> | null> {
  try {
    return await fetchChecks(repo, pr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Failed to fetch CI checks: ${msg}`);
    return null;
  }
}

export async function buildReadyCheck(
  repo: string,
  pr: string,
  prReviewWait: PrReviewWait
): Promise<() => Promise<boolean>> {
  if (prReviewWait.timeoutMinutes <= 0) {
    return () => Promise.resolve(true);
  }

  if (prReviewWait.mode === 'timer') {
    const { stdout } = await gh(['pr', 'view', pr, '-R', repo, '--json', 'createdAt']);
    const { createdAt } = JSON.parse(stdout) as { createdAt: string };
    const deadline = new Date(createdAt).getTime() + prReviewWait.timeoutMinutes * 60_000;

    return () => Promise.resolve(Date.now() >= deadline);
  }

  const deadline = Date.now() + prReviewWait.timeoutMinutes * 60_000;
  const initialChecks = await fetchChecksGraceful(repo, pr);
  const zeroChecksDeadline =
    initialChecks !== null && initialChecks.length === 0
      ? Math.min(deadline, Date.now() + ZERO_CHECKS_GRACE_MS)
      : null;

  return async () => {
    const now = Date.now();
    if (now >= deadline) {
      return true;
    }

    const checks = await fetchChecksGraceful(repo, pr);
    if (zeroChecksDeadline !== null && (checks === null || checks.length === 0)) {
      return now >= zeroChecksDeadline;
    }

    if (checks === null) {
      return false;
    }

    const { pending } = classifyChecks(checks);
    return pending.length === 0;
  };
}

export async function prRemediateCommand(
  repo: string,
  pr?: string,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string
): Promise<void> {
  let issueNumber: string;

  if (!pr) {
    const selected = await autoSelectPrForStage(
      repo,
      'shipper:pr-reviewed',
      "No PRs ready for remediation. Run 'shipper pr review' first."
    );
    console.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = await resolveRef(repo, pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  const prRef = pr;
  if (!prRef) {
    console.error('Error: No PR selected for remediation.');
    process.exit(1);
  }

  const run = async () => {
    const branch = await getBranchForPR(repo, prRef);
    const { stdout: baseBranchStdout } = await gh([
      'pr',
      'view',
      prRef,
      '-R',
      repo,
      '--json',
      'baseRefName',
    ]);
    const { baseRefName: baseBranch } = JSON.parse(baseBranchStdout) as { baseRefName: string };

    return await withStageHooks('pr-remediate', { issueNumber, branchName: branch }, async () => {
      const { prReviewWait } = getSettings();

      if (process.env[SKIP_PR_REMEDIATE_WAIT_ENV_VAR] !== '1') {
        if (prReviewWait.mode === 'timer') {
          if (prReviewWait.timeoutMinutes > 0) {
            const { stdout } = await gh(['pr', 'view', prRef, '-R', repo, '--json', 'createdAt']);
            const { createdAt } = JSON.parse(stdout) as { createdAt: string };
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
          await waitForChecks(repo, prRef, prReviewWait.timeoutMinutes);
        }
      }

      const repoRoot = await getRepoRoot();

      return await withWorktree(
        { repoRoot, branch, createBranch: false, issueNumber, stage: 'pr-remediate' },
        async (wtPath) => {
          return await withGitTransport(
            { wtPath, repoRoot, baseBranch, pushMode: 'force-with-lease' },
            async (conflictContext) =>
              await runPrompt('pr_remediate', {
                repo,
                issueRef: issueNumber,
                prRef,
                cwd: wtPath,
                mode,
                agent,
                model,
                userInput: conflictContext ? formatConflictContext(conflictContext) : undefined,
              })
          );
        }
      );
    });
  };

  try {
    const code = await withIssueLock(repo, issueNumber, run);
    process.exitCode = code;
  } catch (err) {
    if (err instanceof PollingInterruptedError) {
      process.exitCode = 130;
      return;
    }
    throw err;
  }
}
