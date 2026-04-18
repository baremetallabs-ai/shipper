import path from 'node:path';

import {
  autoSelectPrForStage,
  classifyChecks,
  enrichFailedChecks,
  executeTransition,
  fetchChecks,
  formatConflictContext,
  getBranchForPR,
  getCommitsAheadCount,
  getGitRevParse,
  getRepoRoot,
  getSettings,
  gh,
  handleAgentCrash,
  logger,
  parsePrBaseRefNameView,
  parsePrCreatedAtView,
  postComment,
  postReplies,
  processResult,
  pushWithRetry,
  rerunFailedChecks,
  resolveRef,
  resolveTransition,
  retryOnInvalidOutput,
  runPrompt,
  scrubOutputDir,
  setupProtocolDirs,
  sleepMs,
  syncWorktree,
  toErrorMessage,
  truncateLargeInput,
  validateStageOutput,
  withIssueLock,
  withStageHooks,
  withWorktree,
  writeContextFile,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode, PrReviewWait } from '@dnsquared/shipper-core';
import type { StageRunResult } from './stage-result.js';

const ZERO_CHECKS_GRACE_MS = 30_000;
const CI_WAIT_TIMEOUT_MINUTES = 30;
const MAX_REMEDIATION_PASSES = 5;
const MAX_CONSECUTIVE_FETCH_FAILURES = 3;

export interface PrRemediateStageOptions {
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
  skipInitialWait?: boolean;
}

class PollingInterruptedError extends Error {
  constructor() {
    super('Check polling interrupted.');
  }
}

async function waitForChecks(repo: string, pr: string, timeoutMinutes: number): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let previousCompleted = -1;
  let consecutiveFailures = 0;
  let interrupted = false;

  const sigHandler = () => {
    interrupted = true;
    logger.log('\nCheck polling interrupted.');
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
        logger.log('No CI checks found. Proceeding.');
        return;
      }
    }

    // Main poll loop
    for (;;) {
      if (isInterrupted()) break;
      if (Date.now() >= deadline) {
        logger.log('Check polling timed out. Proceeding.');
        break;
      }

      checks = await fetchChecksGraceful(repo, pr);
      if (checks === null) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
          logger.log('Check polling stopped: persistent fetch failures. Proceeding.');
          break;
        }
      } else {
        consecutiveFailures = 0;
        const { pending, total } = classifyChecks(checks);
        const completed = total - pending.length;

        if (completed !== previousCompleted) {
          if (pending.length === 0) {
            logger.log(`All checks complete. (${completed}/${total})`);
            break;
          }
          logger.log(`Waiting for checks... ${completed}/${total} complete`);
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
    logger.warn(`Warning: Failed to fetch CI checks: ${toErrorMessage(err)}`);
    return null;
  }
}

async function getGitRevParseGraceful(cwd: string, ref: string): Promise<string | null> {
  try {
    return await getGitRevParse(cwd, ref);
  } catch (err) {
    logger.warn(`Warning: Failed to resolve git ref ${ref}: ${toErrorMessage(err)}`);
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
  if (prReviewWait.mode === 'timer') {
    if (prReviewWait.durationMinutes <= 0) {
      return () => Promise.resolve(true);
    }

    const { stdout } = await gh(['pr', 'view', pr, '-R', repo, '--json', 'createdAt']);
    const createdAt = parsePrCreatedAtView(stdout).createdAt;
    const deadline = new Date(createdAt).getTime() + prReviewWait.durationMinutes * 60_000;

    return () => Promise.resolve(Date.now() >= deadline);
  }

  const maxDurationMinutes = prReviewWait.maxDurationMinutes;
  const maxDeadline =
    maxDurationMinutes === undefined ? null : Date.now() + maxDurationMinutes * 60_000;
  const minDurationMinutes = prReviewWait.minDurationMinutes;
  const minDeadline =
    minDurationMinutes === undefined
      ? null
      : await (async () => {
          const { stdout } = await gh(['pr', 'view', pr, '-R', repo, '--json', 'createdAt']);
          const createdAt = parsePrCreatedAtView(stdout).createdAt;
          return new Date(createdAt).getTime() + minDurationMinutes * 60_000;
        })();
  let consecutiveFailures = 0;
  const initialChecks = await fetchChecksGraceful(repo, pr);
  const zeroChecksDeadline =
    initialChecks !== null && initialChecks.length === 0
      ? Math.min(maxDeadline ?? Number.POSITIVE_INFINITY, Date.now() + ZERO_CHECKS_GRACE_MS)
      : null;

  return async () => {
    const now = Date.now();
    if (maxDeadline !== null && now >= maxDeadline) {
      return true;
    }
    const minElapsed = minDeadline === null || now >= minDeadline;

    const checks = await fetchChecksGraceful(repo, pr);
    if (checks === null) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
        return minElapsed;
      }
    } else {
      consecutiveFailures = 0;
    }

    if (zeroChecksDeadline !== null && (checks === null || checks.length === 0)) {
      return now >= zeroChecksDeadline && minElapsed;
    }

    if (checks === null) {
      return false;
    }

    const { pending } = classifyChecks(checks);
    return pending.length === 0 && minElapsed;
  };
}

export async function runPrRemediateStage(
  repo: string,
  issueNumber: string,
  prRef: string,
  options: PrRemediateStageOptions = {}
): Promise<StageRunResult> {
  const { mode, agent, model, skipInitialWait = false } = options;
  let failureError: string | undefined;
  let verdict: StageRunResult['verdict'];

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
    const { baseRefName: baseBranch } = parsePrBaseRefNameView(baseBranchStdout);

    return await withStageHooks('pr-remediate', { issueNumber, branchName: branch }, async () => {
      const { prReviewWait } = getSettings();

      if (!skipInitialWait) {
        if (prReviewWait.mode === 'timer') {
          if (prReviewWait.durationMinutes > 0) {
            const { stdout } = await gh(['pr', 'view', prRef, '-R', repo, '--json', 'createdAt']);
            const createdAt = parsePrCreatedAtView(stdout).createdAt;
            const elapsedMs = Date.now() - new Date(createdAt).getTime();
            const waitMs = prReviewWait.durationMinutes * 60_000;
            const remainingMs = waitMs - elapsedMs;

            if (remainingMs > 0) {
              const remainingMin = Math.ceil(remainingMs / 60_000);
              logger.log(
                `PR #${prRef} is ${Math.floor(elapsedMs / 60_000)} minutes old. ` +
                  `Waiting ${remainingMin} more minute(s) for reviewers (prReviewWait.durationMinutes: ${prReviewWait.durationMinutes})...`
              );
              await sleepMs(remainingMs);
            }
          }
        } else {
          const maxDeadline =
            prReviewWait.maxDurationMinutes === undefined
              ? null
              : Date.now() + prReviewWait.maxDurationMinutes * 60_000;
          await waitForChecks(repo, prRef, prReviewWait.maxDurationMinutes ?? Infinity);
          if (
            prReviewWait.minDurationMinutes !== undefined &&
            (maxDeadline === null || Date.now() < maxDeadline)
          ) {
            const { stdout } = await gh(['pr', 'view', prRef, '-R', repo, '--json', 'createdAt']);
            const createdAt = parsePrCreatedAtView(stdout).createdAt;
            const minDeadline =
              new Date(createdAt).getTime() + prReviewWait.minDurationMinutes * 60_000;
            const remainingMs = minDeadline - Date.now();

            if (remainingMs > 0) {
              const remainingMin = Math.ceil(remainingMs / 60_000);
              logger.log(
                `Wait complete. Waiting ${remainingMin} more minute(s) for minimum review window (prReviewWait.minDurationMinutes: ${prReviewWait.minDurationMinutes})...`
              );
              await sleepMs(remainingMs);
            }
          }
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
              const detail = toErrorMessage(error);
              failureError = detail;
              await handleAgentCrash(repo, issueNumber, 'pr_remediate', detail);
              return 1;
            }

            let commitsAhead: number;
            try {
              commitsAhead = await getCommitsAheadCount(wtPath, baseBranch);
            } catch (error) {
              const detail = toErrorMessage(error);
              failureError = detail;
              await handleAgentCrash(repo, issueNumber, 'pr_remediate', detail);
              return 1;
            }

            if (commitsAhead === 0) {
              const detail = `The PR branch has 0 commits ahead of \`origin/${baseBranch}\` after rebase.

This typically means the branch's commits were already on the base branch through another merge path, so the rebase dropped them all.

Suggested recovery: close the PR and reset the issue via \`shipper reset\`.`;
              failureError = detail;
              await handleAgentCrash(repo, issueNumber, 'pr_remediate', detail);
              await executeTransition(
                repo,
                issueNumber,
                resolveTransition('pr_remediate', 'fail'),
                prRef
              );
              return 1;
            }

            await scrubOutputDir(wtPath);

            const exitCode = await runPrompt('pr_remediate', {
              repo,
              issueRef: issueNumber,
              prRef,
              cwd: wtPath,
              mode,
              agent,
              model,
            });
            if (exitCode !== 0) {
              const detail = `Agent exited with code ${exitCode}`;
              logger.error(detail);
              failureError = detail;
              await handleAgentCrash(
                repo,
                issueNumber,
                'pr_remediate',
                detail,
                `The \`pr_remediate\` agent run exited with code ${exitCode}.`
              );
              return 1;
            }

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
              const detail = toErrorMessage(error);
              logger.error(detail);
              failureError = detail;
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
                  prNumber: prRef,
                });
                verdict = result.verdict;
                failureError = `Stage returned verdict "${result.verdict}".`;
                return 1;
              } catch (error) {
                const detail = toErrorMessage(error);
                logger.error(detail);
                failureError = detail;
                await handleAgentCrash(repo, issueNumber, 'pr_remediate', detail);
                return 1;
              }
            }

            const readLatestPostingResult = async () => {
              try {
                return await validateStageOutput(wtPath, 'pr_remediate');
              } catch (error) {
                logger.warn(
                  `Failed to refresh pr_remediate result after push retry; using previously validated output: ${toErrorMessage(error)}`
                );
                return result;
              }
            };

            const remoteRef = `origin/${branch}`;
            const remoteHeadBefore = await getGitRevParseGraceful(wtPath, remoteRef);

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
              const detail = toErrorMessage(error);
              failureError = detail;
              const postingResult = await readLatestPostingResult();
              try {
                await postReplies(repo, prRef, wtPath, postingResult.replies);
              } catch (postRepliesError) {
                logger.warn(
                  `Failed to post replies during push failure handling: ${toErrorMessage(postRepliesError)}`
                );
                // Best-effort: still attempt the main comment and crash report.
              }
              try {
                await postComment(repo, issueNumber, path.resolve(wtPath, postingResult.comment));
              } catch (postCommentError) {
                logger.warn(
                  `Failed to post comment during push failure handling: ${toErrorMessage(postCommentError)}`
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

            const remoteHeadAfter = await getGitRevParseGraceful(wtPath, remoteRef);
            if (
              remoteHeadBefore !== null &&
              remoteHeadAfter !== null &&
              remoteHeadBefore === remoteHeadAfter
            ) {
              const staleChecks = await fetchChecksGraceful(repo, prRef);
              if (staleChecks === null) {
                logger.warn(
                  `Pass ${pass}/${MAX_REMEDIATION_PASSES}: Failed to fetch CI checks before potential re-run.`
                );
              } else {
                const { failed: staleFailures } = classifyChecks(staleChecks);
                if (staleFailures.length > 0) {
                  logger.log(
                    `Pass ${pass}/${MAX_REMEDIATION_PASSES}: No new commits pushed. ` +
                      `Re-running ${staleFailures.length} failed CI check(s)...`
                  );
                  await rerunFailedChecks(repo, staleFailures);
                  await sleepMs(10_000);
                }
              }
            }

            await waitForChecks(repo, prRef, CI_WAIT_TIMEOUT_MINUTES);
            const checks = await fetchChecksGraceful(repo, prRef);
            if (checks === null) {
              logger.error(
                `Pass ${pass}/${MAX_REMEDIATION_PASSES}: Failed to fetch CI checks after waiting. Continuing to next pass.`
              );
              continue;
            }
            const { failed, pending } = classifyChecks(checks);

            if (checks.length > 0 && failed.length === 0 && pending.length === 0) {
              verdict = 'accept';
              await executeTransition(
                repo,
                issueNumber,
                resolveTransition('pr_remediate', 'accept'),
                prRef
              );
              return 0;
            }

            logger.error(
              `Pass ${pass}/${MAX_REMEDIATION_PASSES}: CI not green yet ` +
                `(${checks.length} total, ${failed.length} failing, ${pending.length} pending).`
            );
          }

          failureError = `Remediation exhausted ${MAX_REMEDIATION_PASSES} passes without green CI.`;
          logger.error(failureError);
          return 1;
        }
      );
    });
  };

  try {
    const exitCode = await withIssueLock(repo, issueNumber, run);
    return exitCode === 0
      ? {
          success: true,
          exitCode,
          ...(verdict !== undefined ? { verdict } : {}),
        }
      : {
          success: false,
          exitCode,
          error: failureError ?? `Agent exited with code ${exitCode}`,
          ...(verdict !== undefined ? { verdict } : {}),
        };
  } catch (err) {
    if (err instanceof PollingInterruptedError) {
      return { success: false, exitCode: 130, error: err.message };
    }
    throw err;
  }
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
    logger.error(
      `Auto-selected PR #${selected.pr} (issue #${selected.issue.number}: ${selected.issue.title})`
    );
    pr = selected.pr;
    issueNumber = String(selected.issue.number);
  } else {
    const resolved = await resolveRef(repo, pr, 'both');
    pr = resolved.prNumber;
    issueNumber = resolved.issueNumber;
  }

  if (!pr) {
    throw new Error('Error: No PR selected for remediation.');
  }

  process.exitCode = (
    await runPrRemediateStage(repo, issueNumber, pr, { mode, agent, model })
  ).exitCode;
}
