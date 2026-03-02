import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function getWorktreePath(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const safeBranch = branch.replace(/\//g, '-');
  return path.resolve(repoRoot, '..', `${repoName}--wt--${safeBranch}`);
}

export interface CreateWorktreeOpts {
  repoRoot: string;
  branch: string;
  createBranch: boolean;
}

export function createWorktree(opts: CreateWorktreeOpts): string {
  const wtPath = getWorktreePath(opts.repoRoot, opts.branch);

  if (existsSync(wtPath)) {
    throw new Error(
      `Worktree path already exists: ${wtPath}\n` +
        'A previous run may have crashed. Remove it with:\n' +
        `  git worktree remove --force "${wtPath}"`
    );
  }

  const args = ['worktree', 'add'];
  if (opts.createBranch) {
    args.push('-b', opts.branch);
  }
  args.push(wtPath);
  if (!opts.createBranch) {
    args.push(opts.branch);
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
