import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/user' };
});

const { getWorktreePath } = await import('../../src/lib/worktree.js');

const WORKTREES_DIR = path.join('/home/user', '.shipper', 'worktrees');

describe('getWorktreePath', () => {
  it('generates a path under ~/.shipper/worktrees/', () => {
    const result = getWorktreePath('/repos/my-repo', '42-add-login');
    expect(result).toBe(path.join(WORKTREES_DIR, 'my-repo--wt--42-add-login'));
  });

  it('replaces slashes in branch names with dashes', () => {
    const result = getWorktreePath('/repos/my-repo', 'feature/login');
    expect(result).toBe(path.join(WORKTREES_DIR, 'my-repo--wt--feature-login'));
  });

  it('handles deeply nested branch names', () => {
    const result = getWorktreePath('/repos/my-repo', 'user/feature/sub');
    expect(result).toBe(path.join(WORKTREES_DIR, 'my-repo--wt--user-feature-sub'));
  });

  it('places worktree outside the repo directory', () => {
    const result = getWorktreePath('/repos/my-repo', 'main');
    expect(result).not.toContain('/repos/my-repo/');
    expect(result).toContain('.shipper/worktrees/');
  });
});
