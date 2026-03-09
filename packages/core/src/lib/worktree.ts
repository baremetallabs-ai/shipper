import { execFile, spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runAdvisoryHook, runWorktreeHook } from './hooks.js';
import { getSettings } from './settings.js';

const WORKTREES_DIR = path.join(homedir(), '.shipper', 'worktrees');
const execFileAsync = promisify(execFile);

function spawnAsync(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

export function getWorktreePath(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const safeBranch = branch.replace(/\//g, '-');
  return path.join(WORKTREES_DIR, `${repoName}--wt--${safeBranch}`);
}

export interface CreateWorktreeOpts {
  repoRoot: string;
  branch: string;
  createBranch: boolean;
  issueNumber?: string;
  stage?: string;
}

export async function createWorktree(opts: CreateWorktreeOpts): Promise<string> {
  const wtPath = getWorktreePath(opts.repoRoot, opts.branch);

  try {
    await access(wtPath);
    // Clean up stale worktree from a previous crashed run
    try {
      await spawnAsync('git', ['worktree', 'remove', '--force', wtPath], opts.repoRoot);
    } catch {
      // If git worktree remove fails, try just deleting the directory
    }
  } catch {
    // Worktree doesn't exist
  }

  await mkdir(WORKTREES_DIR, { recursive: true });

  const args = ['worktree', 'add'];
  if (opts.createBranch) {
    // Check if branch already exists (e.g. from a previous crashed run)
    let branchExists = false;
    try {
      await execFileAsync('git', ['rev-parse', '--verify', opts.branch], {
        cwd: opts.repoRoot,
      });
      branchExists = true;
    } catch {
      // Branch doesn't exist — create it
      args.push('-b', opts.branch);
    }
    args.push(wtPath);
    if (branchExists) {
      args.push(opts.branch);
    }
  } else {
    args.push(wtPath, opts.branch);
  }

  await spawnAsync('git', args, opts.repoRoot);

  return wtPath;
}

export async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
  try {
    await spawnAsync('git', ['worktree', 'remove', '--force', wtPath], repoRoot);
  } catch {
    // Idempotent — ignore errors if already removed
  }
}

export async function withWorktree<T>(
  opts: CreateWorktreeOpts,
  fn: (wtPath: string) => Promise<T>
): Promise<T> {
  const wtPath = await createWorktree(opts);
  const hookEnv = {
    SHIPPER_STAGE: opts.stage ?? '',
    SHIPPER_WORKTREE_PATH: wtPath,
    SHIPPER_ISSUE_NUMBER: opts.issueNumber ?? '',
    SHIPPER_BRANCH_NAME: opts.branch,
  };

  const settings = getSettings();
  const { installCommand } = settings;
  if (installCommand) {
    await runAdvisoryHook('Install dependencies', installCommand, hookEnv, wtPath);
  }

  const { worktreeSetup, worktreeTeardown } = settings.hooks;

  await runWorktreeHook('worktree-setup', hookEnv, worktreeSetup, wtPath);

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await runWorktreeHook('worktree-teardown', hookEnv, worktreeTeardown, wtPath);
    await removeWorktree(opts.repoRoot, wtPath);
  };

  const cleanupWithoutAwait = () => {
    void cleanup();
  };

  process.on('SIGINT', cleanupWithoutAwait);
  process.on('SIGTERM', cleanupWithoutAwait);

  try {
    return await fn(wtPath);
  } finally {
    process.removeListener('SIGINT', cleanupWithoutAwait);
    process.removeListener('SIGTERM', cleanupWithoutAwait);
    await cleanup();
  }
}
