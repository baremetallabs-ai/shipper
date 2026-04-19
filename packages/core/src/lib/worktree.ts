import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runAdvisoryHook, runWorktreeHook } from './hooks.js';
import { createLogger } from './logger.js';
import { getSettings } from './settings.js';
import { execAsync, formatCommandFailure, spawnAsync } from './worktree/helpers.js';

export type { ConflictContext, WorktreeGitOpts } from './worktree/helpers.js';
export { getCommitsAheadCount, getGitRevParse } from './worktree/helpers.js';
export { formatConflictContext } from './worktree/conflicts.js';
export { pushWithRetry, pushWorktree } from './worktree/push.js';
export { syncWorktree, withGitTransport } from './worktree/transport.js';

const WORKTREES_DIR = path.join(homedir(), '.shipper', 'worktrees');
const execFileAsync = promisify(execFile);

export function getWorktreePath(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const safeBranch = branch.replace(/\//g, '-');
  return path.join(WORKTREES_DIR, `${repoName}--wt--${safeBranch}`);
}

export interface CreateWorktreeOpts {
  repoRoot: string;
  branch: string;
  createBranch: boolean;
  baseBranch?: string;
  issueNumber?: string;
  stage?: string;
}

export interface CreateWorktreeResult {
  wtPath: string;
  didResetToBase: boolean;
}

export async function createWorktree(opts: CreateWorktreeOpts): Promise<CreateWorktreeResult> {
  const wtPath = getWorktreePath(opts.repoRoot, opts.branch);
  let branchReused = false;
  let didResetToBase = false;

  // Prune stale worktree registrations whose directories no longer exist
  await execAsync('git', ['worktree', 'prune'], { cwd: opts.repoRoot });

  try {
    await access(wtPath);
    // Clean up stale worktree from a previous crashed run
    try {
      await spawnAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: opts.repoRoot });
    } catch {
      // If git worktree remove fails (orphaned directory), delete it directly
      await rm(wtPath, { recursive: true, force: true });
    }
  } catch {
    // Worktree doesn't exist
  }

  await mkdir(WORKTREES_DIR, { recursive: true });

  const args = ['worktree', 'add'];
  if (opts.createBranch) {
    if (!opts.baseBranch) {
      throw new Error('baseBranch is required when createBranch is true');
    }

    const startPoint = `origin/${opts.baseBranch}`;
    const fetchArgs = [
      'fetch',
      'origin',
      `refs/heads/${opts.baseBranch}:refs/remotes/${startPoint}`,
    ];
    const fetchResult = await execAsync('git', fetchArgs, { cwd: opts.repoRoot });
    if (fetchResult.code !== 0) {
      throw new Error(
        `Failed to fetch origin/${opts.baseBranch} before worktree creation: ${formatCommandFailure('git', fetchArgs, fetchResult)}`
      );
    }

    const verifyResult = await execAsync('git', ['rev-parse', '--verify', startPoint], {
      cwd: opts.repoRoot,
    });
    if (verifyResult.code !== 0) {
      throw new Error(
        `Remote ref ${startPoint} does not exist after fetching origin. Ensure the branch '${opts.baseBranch}' exists on origin.\n${formatCommandFailure('git', ['rev-parse', '--verify', startPoint], verifyResult)}`
      );
    }

    // Check if branch already exists (e.g. from a previous crashed run)
    try {
      await execFileAsync('git', ['rev-parse', '--verify', opts.branch], {
        cwd: opts.repoRoot,
      });
      branchReused = true;
    } catch {
      // Branch doesn't exist — create it
      args.push('-b', opts.branch);
    }
    args.push(wtPath);
    if (branchReused) {
      args.push(opts.branch);
    } else {
      args.push(startPoint);
    }
  } else {
    args.push(wtPath, opts.branch);
  }

  await spawnAsync('git', args, { cwd: opts.repoRoot });

  const shouldResetToBase =
    branchReused && opts.baseBranch && (opts.stage === 'design' || opts.stage === 'plan');

  if (shouldResetToBase) {
    const resetTarget = `origin/${opts.baseBranch}`;
    const resetResult = await execAsync('git', ['reset', '--hard', resetTarget], { cwd: wtPath });
    if (resetResult.code !== 0) {
      throw new Error(
        `Failed to reset branch to ${resetTarget}: ${formatCommandFailure('git', ['reset', '--hard', resetTarget], resetResult)}`
      );
    }
    didResetToBase = true;
  }

  return { wtPath, didResetToBase };
}

export async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
  try {
    await spawnAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot });
  } catch {
    // Not a registered worktree — remove the orphaned directory
    await rm(wtPath, { recursive: true, force: true });
  }
}

export async function withWorktree<T>(
  opts: CreateWorktreeOpts,
  fn: (wtPath: string) => Promise<T>
): Promise<T> {
  const worktreeLogger = createLogger();
  worktreeLogger.worktreeStep('creating branch');
  const { wtPath, didResetToBase } = await createWorktree(opts);
  if (didResetToBase && opts.baseBranch) {
    worktreeLogger.worktreeStep(`resetting to origin/${opts.baseBranch}`);
  }
  const hookEnv = {
    SHIPPER_STAGE: opts.stage ?? '',
    SHIPPER_WORKTREE_PATH: wtPath,
    SHIPPER_ISSUE_NUMBER: opts.issueNumber ?? '',
    SHIPPER_BRANCH_NAME: opts.branch,
  };

  const settings = getSettings();
  const worktreeEnv = {
    NPM_CONFIG_CACHE: path.join(wtPath, '.shipper', 'tmp', '.npm-cache'),
    XDG_CACHE_HOME: path.join(wtPath, '.shipper', 'tmp', '.cache'),
    TURBO_CACHE_DIR: path.join(wtPath, '.shipper', 'tmp', '.turbo-cache'),
    ...(settings.worktreeEnv ?? {}),
  };
  const originalEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(worktreeEnv)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async () => {
    cleanupPromise ??= (async () => {
      try {
        await runWorktreeHook('worktree-teardown', hookEnv, wtPath);
        await removeWorktree(opts.repoRoot, wtPath);
        worktreeLogger.worktreeStep('teardown complete');
      } finally {
        for (const [key, value] of originalEnv) {
          if (value === undefined) {
            Reflect.deleteProperty(process.env, key);
            continue;
          }
          process.env[key] = value;
        }
      }
    })();

    await cleanupPromise;
  };

  const cleanupWithoutAwait = () => {
    void cleanup();
  };

  process.on('SIGINT', cleanupWithoutAwait);
  process.on('SIGTERM', cleanupWithoutAwait);

  const { installCommand } = settings;
  try {
    if (installCommand) {
      worktreeLogger.worktreeStep('installing dependencies');
      await runAdvisoryHook('Install dependencies', installCommand, hookEnv, wtPath);
    }

    worktreeLogger.worktreeStep('running setup hooks');
    await runWorktreeHook('worktree-setup', hookEnv, wtPath);
    worktreeLogger.worktreeStep('running agent');
    return await fn(wtPath);
  } finally {
    process.removeListener('SIGINT', cleanupWithoutAwait);
    process.removeListener('SIGTERM', cleanupWithoutAwait);
    await cleanup();
  }
}
