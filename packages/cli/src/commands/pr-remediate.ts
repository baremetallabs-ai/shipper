import path from 'node:path';

import { getBranchForPR, getRepoRoot } from '@dnsquared/shipper-core';
import { fetchChecks, classifyChecks, enrichFailedChecks } from '@dnsquared/shipper-core';
import { autoSelectPrForStage, resolveRef } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { formatConflictContext } from '@dnsquared/shipper-core';
import { gh } from '@dnsquared/shipper-core';
import { withStageHooks } from '@dnsquared/shipper-core';
import { withIssueLock } from '@dnsquared/shipper-core';
import { withWorktree } from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';
import { truncateLargeInput } from '@dnsquared/shipper-core';
import { getSettings } from '@dnsquared/shipper-core';
import type { PrReviewWait } from '@dnsquared/shipper-core';
import {
  executeTransition,
  handleAgentCrash,
  postComment,
  postReplies,
  processResult,
  retryOnInvalidOutput,
  resolveTransition,
  scrubOutputDir,
  setupProtocolDirs,
  syncWorktree,
  pushWithRetry,
  validateStageOutput,
  writeContextFile,
} from '@dnsquared/shipper-core';

import { sleepMs } from '@dnsquared/shipper-core';

const ZERO_CHECKS_GRACE_MS = 30_000;
const CI_WAIT_TIMEOUT_MINUTES = 30;
const MAX_REMEDIATION_PASSES = 5;
export const SKIP_PR_REMEDIATE_WAIT_ENV_VAR = 'SHIPPER_SKIP_PR_REMEDIATE_WAIT';

class PollingInterruptedError extends Error {
  constructor() {
    super('Check polling interrupted.');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCreatedAt(json: string): string {
  const parsed: unknown = JSON.parse(json);
  if (!isPlainObject(parsed) || typeof parsed.createdAt !== 'string') {
    throw new Error('GitHub CLI returned an invalid createdAt payload.');
  }

  return parsed.createdAt;
}

async function waitForChecks(repo: string, pr: string, timeoutMinutes: number): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let previousCompleted = -1;
  let consecutiveFailures = 0;
  let interrupted = false;

  const sigHandler = () => {
    interrupted = true;
    console.log('\nCheck polling interrupted.');
  };
  const isInterrupted = (): boolean => interrupted;
  process.on('SIGINT', sigHandler);

  try {
    // Zero-checks grace period: retry up to 3 times at 10s intervals
    let checks = await fetchChecksGraceful(repo, pr);
    if (checks !== null && checks.length === 0) {
      for (let retry = 0; retry < 3; retry++) {
        if (isInterrupted()) break;
        if (Date.now() >= deadline) break;
        await sleepMs(10_000);
        if (isInterrupted()) break;
        checks = await fetchChecksGraceful(repo, pr);
        if (checks !== null && checks.length > 0) break;
      }
      if (!isInterrupted() && (checks === null || checks.length === 0)) {
        console.log('No CI checks found. Proceeding.');
        return;
      }
    }

    // Main poll loop
    for (;;) {
      if (isInterrupted()) break;
      if (Date.now() >= deadline) {
        console.log('Check polling timed out. Proceeding.');
        break;
      }

      checks = await fetchChecksGraceful(repo, pr);
      if (checks === null) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          console.log('Check polling stopped: persistent fetch failures. Proceeding.');
          break;
        }
      } else {
        consecutiveFailures = 0;
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

async function preflight(
  wtPath: string,
  repo: string,
  prNumber: string,
  pass: number,
  maxPasses: number
): Promise<void> {
  await setupProtocolDirs(wtPath);

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo slug: ${repo}`);
  }

  const reviewThreadsQuery = [
    'query($owner: String!, $repo: String!, $number: Int!) {',
    '  repository(owner: $owner, name: $repo) {',
    '    pullRequest(number: $number) {',
    '      reviewThreads(first: 100) {',
    '        nodes {',
    '          path',
    '          line',
    '          isResolved',
    '          isOutdated',
    '          comments(first: 100) {',
    '            nodes {',
    '              databaseId',
    '              author {',
    '                login',
    '              }',
    '              body',
    '              createdAt',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const reviewThreadsJq = [
    '.data.repository.pullRequest.reviewThreads.nodes',
    '| map({',
    '    path,',
    '    line,',
    '    isResolved,',
    '    isOutdated,',
    '    comments: (',
    '      .comments.nodes',
    '      | map({',
    '          id: .databaseId,',
    '          author: .author.login,',
    '          body,',
    '          createdAt',
    '        })',
    '    )',
    '  })',
  ].join('\n');
  const { stdout: reviewThreads } = await gh([
    'api',
    'graphql',
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repoName}`,
    '-F',
    `number=${prNumber}`,
    '-f',
    `query=${reviewThreadsQuery}`,
    '--jq',
    reviewThreadsJq,
  ]);
  await writeContextFile(wtPath, 'review-threads.json', reviewThreads);

  const checks = await fetchChecks(repo, prNumber);
  const classified = classifyChecks(checks);
  const logDumps = await enrichFailedChecks(repo, classified.failed);
  await writeContextFile(wtPath, 'ci-status.json', JSON.stringify(classified, null, 2));
  for (const [name, content] of logDumps) {
    await writeContextFile(wtPath, `ci-log-${name}.txt`, content);
  }

  const { stdout: diff } = await gh(['pr', 'diff', prNumber, '-R', repo]);
  await writeContextFile(wtPath, 'pr-diff.patch', diff);

  await writeContextFile(wtPath, 'pass-info.json', JSON.stringify({ pass, maxPasses }, null, 2));
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
    const createdAt = parseCreatedAt(stdout);
    const deadline = new Date(createdAt).getTime() + prReviewWait.timeoutMinutes * 60_000;

    return () => Promise.resolve(Date.now() >= deadline);
  }

  const deadline = Date.now() + prReviewWait.timeoutMinutes * 60_000;
  let consecutiveFailures = 0;
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
    if (checks === null) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) {
        return true;
      }
    } else {
      consecutiveFailures = 0;
    }

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
          const gitOpts = { wtPath, repoRoot, baseBranch, pushMode: 'force-with-lease' as const };

          for (let pass = 1; pass <= MAX_REMEDIATION_PASSES; pass++) {
            await preflight(wtPath, repo, prRef, pass, MAX_REMEDIATION_PASSES);

            try {
              await syncWorktree(
                gitOpts,
                async (conflictContext) => {
                  return await runPrompt('pr_remediate', {
                    repo,
                    issueRef: issueNumber,
                    prRef,
                    cwd: wtPath,
                    mode,
                    agent,
                    model,
                    userInput: await truncateLargeInput(
                      wtPath,
                      formatConflictContext(conflictContext),
                      'conflict-context.txt'
                    ),
                  });
                },
                async (installError) => {
                  return await runPrompt('pr_remediate', {
                    repo,
                    issueRef: issueNumber,
                    prRef,
                    cwd: wtPath,
                    mode,
                    agent,
                    model,
                    userInput: await truncateLargeInput(wtPath, installError, 'install-error.txt'),
                  });
                }
              );
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              await handleAgentCrash(repo, issueNumber, 'pr_remediate', detail);
              return 1;
            }

            await scrubOutputDir(wtPath);

            await runPrompt('pr_remediate', {
              repo,
              issueRef: issueNumber,
              prRef,
              cwd: wtPath,
              mode,
              agent,
              model,
            });

            let result: Awaited<ReturnType<typeof retryOnInvalidOutput>>;
            try {
              result = await retryOnInvalidOutput({
                cwd: wtPath,
                stage: 'pr_remediate',
                retry: (userInput) =>
                  runPrompt('pr_remediate', {
                    repo,
                    issueRef: issueNumber,
                    prRef,
                    cwd: wtPath,
                    mode,
                    agent,
                    model,
                    userInput,
                  }),
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              console.error(detail);
              await handleAgentCrash(repo, issueNumber, 'pr_remediate', detail);
              return 1;
            }

            if (result.verdict === 'reject' || result.verdict === 'fail') {
              try {
                await processResult({
                  repo,
                  issueNumber,
                  stage: 'pr_remediate',
                  cwd: wtPath,
                  result,
                });
                return 0;
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                console.error(detail);
                await handleAgentCrash(repo, issueNumber, 'pr_remediate', detail);
                return 1;
              }
            }

            const readLatestPostingResult = async () => {
              try {
                return await validateStageOutput(wtPath, 'pr_remediate');
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                console.warn(
                  `Failed to refresh pr_remediate result after push retry; using previously validated output: ${detail}`
                );
                return result;
              }
            };

            try {
              const pushCode = await pushWithRetry(
                gitOpts,
                (conflictContext, pushError, installError) => {
                  return runPrompt('pr_remediate', {
                    repo,
                    issueRef: issueNumber,
                    prRef,
                    cwd: wtPath,
                    mode,
                    agent,
                    model,
                    userInput: conflictContext
                      ? formatConflictContext(conflictContext)
                      : (pushError ?? installError ?? undefined),
                  });
                }
              );
              if (pushCode !== 0) {
                throw new Error(`Push retry agent exited with code ${pushCode}`);
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              const postingResult = await readLatestPostingResult();
              try {
                await postReplies(repo, prRef, wtPath, postingResult.replies);
              } catch (postRepliesError) {
                console.warn(
                  `Failed to post replies during push failure handling: ${
                    postRepliesError instanceof Error
                      ? postRepliesError.message
                      : String(postRepliesError)
                  }`
                );
                // Best-effort: still attempt the main comment and crash report.
              }
              try {
                await postComment(repo, issueNumber, path.resolve(wtPath, postingResult.comment));
              } catch (postCommentError) {
                console.warn(
                  `Failed to post comment during push failure handling: ${
                    postCommentError instanceof Error
                      ? postCommentError.message
                      : String(postCommentError)
                  }`
                );
                // Best-effort: the crash report is the required audit trail.
              }
              await handleAgentCrash(
                repo,
                issueNumber,
                'pr_remediate',
                detail,
                'The `pr_remediate` agent run failed while pushing the remediation worktree after producing a valid `.shipper/output/result.json`.'
              );
              return 1;
            }

            const postingResult = await readLatestPostingResult();
            await postReplies(repo, prRef, wtPath, postingResult.replies);
            await postComment(repo, issueNumber, path.resolve(wtPath, postingResult.comment));

            await waitForChecks(repo, prRef, CI_WAIT_TIMEOUT_MINUTES);
            const checks = await fetchChecks(repo, prRef);
            const { failed, pending } = classifyChecks(checks);

            if (checks.length > 0 && failed.length === 0 && pending.length === 0) {
              await executeTransition(
                repo,
                issueNumber,
                resolveTransition('pr_remediate', 'accept')
              );
              return 0;
            }

            console.error(
              `Pass ${pass}/${MAX_REMEDIATION_PASSES}: CI not green yet ` +
                `(${checks.length} total, ${failed.length} failing, ${pending.length} pending).`
            );
          }

          console.error(`Remediation exhausted ${MAX_REMEDIATION_PASSES} passes without green CI.`);
          return 0;
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
