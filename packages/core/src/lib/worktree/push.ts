import { logger } from '../logger.js';
import {
  MAX_PUSH_ATTEMPTS,
  MAX_REBASE_ATTEMPTS,
  PUSH_OUTPUT_MAX_BUFFER,
  execAsync,
  fetchOriginOrThrow,
  formatCommandFailure,
  formatTransportError,
  getCommitsAheadCount,
  getCurrentBranch,
  remoteRefExists,
  type ConflictContext,
  type CommandResult,
  type WorktreeGitOpts,
} from './helpers.js';
import {
  abortRebase,
  appendAbortFailure,
  buildConflictContext,
  getConflictContextOrThrow,
  getRetryFailureText,
  isRebaseComplete,
  stageResolvedFiles,
} from './conflicts.js';
import { stripProtectedPaths } from './protected-paths.js';

const HOOK_FAILURE_PATTERN = /husky|lefthook|pre-push|simple-git-hooks|overcommit/i;

function getPushArgs(pushMode: WorktreeGitOpts['pushMode'], forcePushBranch?: string): string[] {
  return pushMode === 'new-branch'
    ? ['push', '-u', 'origin', 'HEAD']
    : forcePushBranch
      ? ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${forcePushBranch}`]
      : ['push', '--force-with-lease'];
}

async function pushWorktreeBranch(
  opts: WorktreeGitOpts,
  pushMode: WorktreeGitOpts['pushMode'],
  forcePushBranch?: string
): Promise<CommandResult> {
  if (pushMode === 'force-with-lease') {
    let commitsAhead: number | undefined;

    try {
      commitsAhead = await getCommitsAheadCount(opts.wtPath, opts.baseBranch);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        `Commit-count safety check failed before force-push; proceeding with push.\n${errorMessage}`
      );
    }

    if (commitsAhead === 0) {
      throw formatTransportError(
        opts,
        'Refusing to push: branch has 0 commits ahead of base branch'
      );
    }
  }

  await stripProtectedPaths(opts);

  const checkoutResult = await execAsync('git', ['checkout', 'HEAD', '--', '.'], {
    cwd: opts.wtPath,
  });
  if (checkoutResult.code !== 0) {
    throw formatTransportError(
      opts,
      `Failed to clean tracked files before push: ${formatCommandFailure('git', ['checkout', 'HEAD', '--', '.'], checkoutResult)}`
    );
  }

  const cleanResult = await execAsync('git', ['clean', '-fd', '--exclude=.shipper'], {
    cwd: opts.wtPath,
    maxBuffer: PUSH_OUTPUT_MAX_BUFFER,
  });
  if (cleanResult.code !== 0) {
    throw formatTransportError(
      opts,
      `Failed to remove untracked files before push: ${formatCommandFailure('git', ['clean', '-fd', '--exclude=.shipper'], cleanResult)}`
    );
  }

  return await execAsync('git', getPushArgs(pushMode, forcePushBranch), {
    cwd: opts.wtPath,
    maxBuffer: PUSH_OUTPUT_MAX_BUFFER,
  });
}

export async function pushWithRetry(
  opts: WorktreeGitOpts,
  runAgent: (
    conflictContext?: ConflictContext,
    pushError?: string,
    installError?: string
  ) => Promise<number>
): Promise<number> {
  let retries = 0;
  let pushMode = opts.pushMode;
  let forcePushBranch: string | undefined;
  if (pushMode === 'force-with-lease') {
    forcePushBranch = await getCurrentBranch(opts);
  }

  for (;;) {
    const pushArgs = getPushArgs(pushMode, forcePushBranch);
    const pushResult = await pushWorktreeBranch(opts, pushMode, forcePushBranch);
    if (pushResult.code === 0) {
      return 0;
    }

    const pushOutput = [pushResult.stderr.trim(), pushResult.stdout.trim()]
      .filter(Boolean)
      .join('\n');
    const pushError = formatCommandFailure('git', pushArgs, pushResult);
    if (retries === MAX_PUSH_ATTEMPTS) {
      throw formatTransportError(
        opts,
        `Push failed after ${MAX_PUSH_ATTEMPTS} retry attempts.\n${pushError}`
      );
    }

    if (!HOOK_FAILURE_PATTERN.test(pushOutput)) {
      await fetchOriginOrThrow(opts);

      const currentBranch = await getCurrentBranch(opts);
      const targetRef = `origin/${currentBranch}`;
      if (await remoteRefExists(opts, targetRef)) {
        const rebaseResult = await execAsync('git', ['rebase', '--autostash', targetRef], {
          cwd: opts.wtPath,
        });

        if (rebaseResult.code !== 0) {
          let conflictContext = await getConflictContextOrThrow(opts, targetRef, rebaseResult);

          for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
            const agentCode = await runAgent(conflictContext);
            if (agentCode !== 0) {
              logger.error(`Agent exited with code ${agentCode} — skipping push.`);
              return agentCode;
            }

            await stageResolvedFiles(opts.wtPath);
            const continueResult = await execAsync('git', ['rebase', '--continue'], {
              cwd: opts.wtPath,
              env: { GIT_EDITOR: 'true' },
            });
            if (continueResult.code === 0) {
              break;
            }

            const continueError = getRetryFailureText(continueResult);
            if (attempt === MAX_REBASE_ATTEMPTS) {
              const abortFailure = await abortRebase(opts.wtPath);
              throw formatTransportError(
                opts,
                appendAbortFailure(
                  `Could not complete rebase onto ${targetRef} after ${MAX_REBASE_ATTEMPTS} conflict resolution attempts.\n${continueError}`,
                  abortFailure
                )
              );
            }

            const nextConflictContext = await buildConflictContext(opts.wtPath, continueError);
            if (!nextConflictContext) {
              if (await isRebaseComplete(opts.wtPath)) {
                break;
              }

              const abortFailure = await abortRebase(opts.wtPath);
              throw formatTransportError(
                opts,
                appendAbortFailure(
                  `git rebase --continue failed without unresolved files.\n${formatCommandFailure(
                    'git',
                    ['rebase', '--continue'],
                    continueResult
                  )}`,
                  abortFailure
                )
              );
            }
            conflictContext = nextConflictContext;
          }
        }

        if (pushMode === 'new-branch') {
          pushMode = 'force-with-lease';
          forcePushBranch = currentBranch;
        }
      }
    }

    const agentCode = await runAgent(undefined, pushError);
    if (agentCode !== 0) {
      logger.error(`Agent exited with code ${agentCode} while handling push failure; retrying.`);
    }

    retries += 1;
  }
}

export async function pushWorktree(opts: WorktreeGitOpts): Promise<void> {
  let pushMode = opts.pushMode;
  let forcePushBranch: string | undefined;
  if (pushMode === 'force-with-lease') {
    forcePushBranch = await getCurrentBranch(opts);
  }
  let retries = 0;

  for (;;) {
    const pushArgs = getPushArgs(pushMode, forcePushBranch);
    const pushResult = await pushWorktreeBranch(opts, pushMode, forcePushBranch);
    if (pushResult.code === 0) {
      return;
    }

    if (retries >= MAX_PUSH_ATTEMPTS) {
      throw formatTransportError(opts, formatCommandFailure('git', pushArgs, pushResult));
    }

    await fetchOriginOrThrow(opts);

    const currentBranch = await getCurrentBranch(opts);
    const targetRef = `origin/${currentBranch}`;
    if (!(await remoteRefExists(opts, targetRef))) {
      retries += 1;
      continue;
    }

    const rebaseResult = await execAsync('git', ['rebase', '--autostash', targetRef], {
      cwd: opts.wtPath,
    });
    if (rebaseResult.code !== 0) {
      const abortFailure = await abortRebase(opts.wtPath);
      throw formatTransportError(
        opts,
        appendAbortFailure(
          `git rebase --autostash ${targetRef} failed.\n${formatCommandFailure(
            'git',
            ['rebase', '--autostash', targetRef],
            rebaseResult
          )}`,
          abortFailure
        )
      );
    }

    if (pushMode === 'new-branch') {
      pushMode = 'force-with-lease';
      forcePushBranch = currentBranch;
    }

    retries += 1;
  }
}
