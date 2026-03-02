import { describe, it, expect } from 'vitest';
import { getWorktreePath } from '../../src/lib/worktree.js';

describe('getWorktreePath', () => {
  it('generates a sibling path with branch name', () => {
    const result = getWorktreePath('/home/user/my-repo', '42-add-login');
    expect(result).toMatch(/my-repo--wt--42-add-login$/);
  });

  it('replaces slashes in branch names with dashes', () => {
    const result = getWorktreePath('/home/user/my-repo', 'feature/login');
    expect(result).toMatch(/my-repo--wt--feature-login$/);
  });

  it('handles deeply nested branch names', () => {
    const result = getWorktreePath('/home/user/my-repo', 'user/feature/sub');
    expect(result).toMatch(/my-repo--wt--user-feature-sub$/);
  });

  it('places worktree as sibling of repo', () => {
    const result = getWorktreePath('/home/user/my-repo', 'main');
    expect(result).not.toContain('my-repo/');
    expect(result).toContain('my-repo--wt--main');
  });
});
