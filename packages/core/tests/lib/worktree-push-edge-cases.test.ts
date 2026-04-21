// Scope: preserve only push-preparation and recovery branches that are not stable to reproduce with real repos.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execAsyncMock = vi.fn();
const fetchOriginOrThrowMock = vi.fn();
const getCurrentBranchMock = vi.fn();
const getCommitsAheadCountMock = vi.fn();
const remoteRefExistsMock = vi.fn();
const stripProtectedPathsMock = vi.fn();
const abortRebaseMock = vi.fn();

vi.mock('../../src/lib/worktree/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/worktree/helpers.js')>(
    '../../src/lib/worktree/helpers.js'
  );
  return {
    ...actual,
    execAsync: execAsyncMock,
    fetchOriginOrThrow: fetchOriginOrThrowMock,
    getCurrentBranch: getCurrentBranchMock,
    getCommitsAheadCount: getCommitsAheadCountMock,
    remoteRefExists: remoteRefExistsMock,
  };
});

vi.mock('../../src/lib/worktree/protected-paths.js', () => ({
  stripProtectedPaths: stripProtectedPathsMock,
}));

vi.mock('../../src/lib/worktree/conflicts.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/worktree/conflicts.js')>(
    '../../src/lib/worktree/conflicts.js'
  );
  return {
    ...actual,
    abortRebase: abortRebaseMock,
  };
});

const { pushWorktree } = await import('../../src/lib/worktree.js');

describe('push edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripProtectedPathsMock.mockResolvedValue(undefined);
    fetchOriginOrThrowMock.mockResolvedValue(undefined);
    getCurrentBranchMock.mockResolvedValue('feature/retry');
    getCommitsAheadCountMock.mockResolvedValue(1);
    remoteRefExistsMock.mockResolvedValue(false);
    abortRebaseMock.mockResolvedValue(undefined);
  });

  it('surfaces git ls-files failures from protected-path stripping', async () => {
    stripProtectedPathsMock.mockRejectedValue(
      new Error('git ls-files -- .shipper/output/ .shipper/input/ .shipper/tmp/')
    );

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).rejects.toThrow('git ls-files -- .shipper/output/ .shipper/input/ .shipper/tmp/');
  });

  it('aborts before push when git checkout -- . fails', async () => {
    execAsyncMock.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'checkout failed' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).rejects.toThrow('Failed to clean tracked files before push');
  });

  it('aborts before push when git clean -fd --exclude=.shipper fails', async () => {
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'clean failed' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).rejects.toThrow('Failed to remove untracked files before push');
  });

  it('preserves abort failure detail when the recovery rebase fails', async () => {
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'non-fast-forward' }) // push
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'merge conflict' }); // recovery rebase
    remoteRefExistsMock.mockResolvedValue(true);
    abortRebaseMock.mockResolvedValue('git exited with code 1');

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      })
    ).rejects.toThrow(
      'git rebase --autostash origin/feature/retry failed.\ngit rebase --autostash origin/feature/retry exited with code 1:\nmerge conflict\nA best-effort git rebase --abort also failed: git exited with code 1'
    );
  });
});
