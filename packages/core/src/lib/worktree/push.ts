import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
const PRE_PUSH_WRAPPER_PREFIX = 'shipper-pre-push-';

// Neutralize git's leaked `-c key=value` overrides so a nested `git rev-parse`
// reads the repo's actual config instead of the ambient outer push's hooksPath.
// Setting GIT_CONFIG_COUNT=0 makes git ignore any GIT_CONFIG_KEY_n / VALUE_n
// pairs propagated by the outer process; clearing GIT_CONFIG_PARAMETERS handles
// the older single-string form.
const NEUTRALIZE_LEAKED_GIT_CONFIG = {
  GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_PARAMETERS: '',
};

interface PreparedPushCommand {
  args: string[];
  cleanup?: () => Promise<void>;
  env?: typeof process.env;
}

function getPushArgs(pushMode: WorktreeGitOpts['pushMode'], forcePushBranch?: string): string[] {
  return pushMode === 'new-branch'
    ? ['push', '-u', 'origin', 'HEAD']
    : forcePushBranch
      ? ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${forcePushBranch}`]
      : ['push', '--force-with-lease'];
}

function resolveGitPath(wtPath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(wtPath, gitPath);
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Hazard: `git -c key=value ... push` propagates its override to nested `git`
// invocations via GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n, and
// the older GIT_CONFIG_PARAMETERS form. Any new nested `git` call here will
// inherit the outer `-c` override unless those vars are neutralized. Reuse
// NEUTRALIZE_LEAKED_GIT_CONFIG for direct nested `git` spawns; the wrapper
// script body below repeats the same neutralization for hook-spawned children.
async function preparePushCommand(
  opts: WorktreeGitOpts,
  pushMode: WorktreeGitOpts['pushMode'],
  forcePushBranch?: string
): Promise<PreparedPushCommand> {
  const pushArgs = getPushArgs(pushMode, forcePushBranch);
  const hooksPathArgs = ['rev-parse', '--git-path', 'hooks'];
  const hooksPathResult = await execAsync('git', hooksPathArgs, {
    cwd: opts.wtPath,
    env: NEUTRALIZE_LEAKED_GIT_CONFIG,
  });
  if (hooksPathResult.code !== 0) {
    throw formatTransportError(opts, formatCommandFailure('git', hooksPathArgs, hooksPathResult));
  }

  const hooksDir = resolveGitPath(opts.wtPath, hooksPathResult.stdout.trim());
  const prePushHookPath = path.join(hooksDir, 'pre-push');
  if (!(await isExecutable(prePushHookPath))) {
    return { args: pushArgs };
  }

  const wrapperDir = await mkdtemp(path.join(tmpdir(), PRE_PUSH_WRAPPER_PREFIX));
  const wrapperPath = path.join(wrapperDir, 'pre-push');
  await writeFile(
    wrapperPath,
    [
      '#!/bin/sh',
      'unset GIT_DIR GIT_WORK_TREE GIT_CONFIG_PARAMETERS',
      'if [ -n "${GIT_CONFIG_COUNT-}" ]; then',
      '  i=0',
      '  while [ "$i" -lt "$GIT_CONFIG_COUNT" ]; do',
      '    unset "GIT_CONFIG_KEY_$i" "GIT_CONFIG_VALUE_$i"',
      '    i=$((i + 1))',
      '  done',
      '  unset GIT_CONFIG_COUNT',
      'fi',
      'exec "$SHIPPER_ORIGINAL_PRE_PUSH" "$@"',
      '',
    ].join('\n')
  );
  await chmod(wrapperPath, 0o755);

  return {
    args: ['-c', `core.hooksPath=${wrapperDir}`, ...pushArgs],
    cleanup: async () => {
      await rm(wrapperDir, { recursive: true, force: true });
    },
    env: {
      SHIPPER_ORIGINAL_PRE_PUSH: prePushHookPath,
    },
  };
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

  const pushCommand = await preparePushCommand(opts, pushMode, forcePushBranch);
  try {
    return await execAsync('git', pushCommand.args, {
      cwd: opts.wtPath,
      env: pushCommand.env,
      maxBuffer: PUSH_OUTPUT_MAX_BUFFER,
    });
  } finally {
    if (pushCommand.cleanup) {
      try {
        await pushCommand.cleanup();
      } catch (error) {
        logger.error(
          `Failed to remove temporary pre-push hook wrapper.\n${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
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
