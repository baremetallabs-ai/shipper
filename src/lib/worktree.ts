import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const WORKTREES_DIR = path.join(homedir(), '.shipper', 'worktrees');

export function getWorktreePath(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const safeBranch = branch.replace(/\//g, '-');
  return path.join(WORKTREES_DIR, `${repoName}--wt--${safeBranch}`);
}

export interface CreateWorktreeOpts {
  repoRoot: string;
  branch: string;
  createBranch: boolean;
}

export function createWorktree(opts: CreateWorktreeOpts): string {
  const wtPath = getWorktreePath(opts.repoRoot, opts.branch);

  if (existsSync(wtPath)) {
    // Clean up stale worktree from a previous crashed run
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], {
        cwd: opts.repoRoot,
        stdio: 'inherit',
      });
    } catch {
      // If git worktree remove fails, try just deleting the directory
    }
  }

  mkdirSync(WORKTREES_DIR, { recursive: true });

  const args = ['worktree', 'add'];
  if (opts.createBranch) {
    // Check if branch already exists (e.g. from a previous crashed run)
    let branchExists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', opts.branch], {
        cwd: opts.repoRoot,
        stdio: 'ignore',
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

  execFileSync('git', args, { cwd: opts.repoRoot, stdio: 'inherit' });

  return wtPath;
}

export function removeWorktree(repoRoot: string, wtPath: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', wtPath], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  } catch {
    // Idempotent — ignore errors if already removed
  }
}

export function withWorktree<T>(opts: CreateWorktreeOpts, fn: (wtPath: string) => T): T {
  const wtPath = createWorktree(opts);

  const cleanup = () => {
    removeWorktree(opts.repoRoot, wtPath);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    return fn(wtPath);
  } finally {
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    cleanup();
  }
}
