// Scope: preserve transport branches that need narrow seam control over process-error shapes
// or retry bookkeeping that would be brittle to drive with real git fixtures.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execAsyncMock = vi.fn();
const spawnAsyncMock = vi.fn();
const syncWithRemoteBranchMock = vi.fn();
const fetchOriginOrThrowMock = vi.fn();
const getCurrentBranchMock = vi.fn();
const getCommitsAheadCountMock = vi.fn();
const remoteRefExistsMock = vi.fn();
const getSettingsMock = vi.fn<() => { installCommand?: string }>();
const stageResolvedFilesMock = vi.fn();
const getConflictContextOrThrowMock = vi.fn();
const buildConflictContextMock = vi.fn();
const abortRebaseMock = vi.fn();
const isRebaseCompleteMock = vi.fn();

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: (): { installCommand?: string } => getSettingsMock(),
}));

vi.mock('../../src/lib/worktree/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/worktree/helpers.js')>(
    '../../src/lib/worktree/helpers.js'
  );
  return {
    ...actual,
    execAsync: execAsyncMock,
    fetchOriginOrThrow: fetchOriginOrThrowMock,
    getCommitsAheadCount: getCommitsAheadCountMock,
    getCurrentBranch: getCurrentBranchMock,
    remoteRefExists: remoteRefExistsMock,
    spawnAsync: spawnAsyncMock,
    syncWithRemoteBranch: syncWithRemoteBranchMock,
  };
});

vi.mock('../../src/lib/worktree/conflicts.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/worktree/conflicts.js')>(
    '../../src/lib/worktree/conflicts.js'
  );
  return {
    ...actual,
    abortRebase: abortRebaseMock,
    buildConflictContext: buildConflictContextMock,
    getConflictContextOrThrow: getConflictContextOrThrowMock,
    isRebaseComplete: isRebaseCompleteMock,
    stageResolvedFiles: stageResolvedFilesMock,
  };
});

const { syncWorktree, withGitTransport } = await import('../../src/lib/worktree.js');

describe('transport edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockReturnValue({});
    spawnAsyncMock.mockResolvedValue(undefined);
    syncWithRemoteBranchMock.mockResolvedValue(undefined);
    fetchOriginOrThrowMock.mockResolvedValue(undefined);
    getCurrentBranchMock.mockResolvedValue('feature/retry');
    getCommitsAheadCountMock.mockResolvedValue(1);
    remoteRefExistsMock.mockResolvedValue(false);
    stageResolvedFilesMock.mockResolvedValue(undefined);
    isRebaseCompleteMock.mockResolvedValue(false);
    buildConflictContextMock.mockResolvedValue({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> origin/main'],
        },
      ],
    });
    getConflictContextOrThrowMock.mockResolvedValue({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> origin/main'],
        },
      ],
    });
    abortRebaseMock.mockResolvedValue(undefined);
  });

  it('passes message-only install failures to remediation and surfaces a non-zero remediation exit', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    execAsyncMock.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }).mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'stdout maxBuffer length exceeded',
    });

    const remediateInstallError = vi.fn().mockResolvedValue(9);

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        vi.fn(),
        remediateInstallError
      )
    ).rejects.toThrow(
      'Git transport failed in /tmp/wt for repo /tmp/repo: Install remediation agent exited with code 9'
    );

    expect(remediateInstallError).toHaveBeenCalledWith(
      'npm ci exited with code 1:\nstdout maxBuffer length exceeded'
    );
  });

  it('preserves the transport failure when rebase abort also fails after repeated conflict retries', async () => {
    execAsyncMock
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'merge conflict' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'continue failed once' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'continue failed twice' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'continue failed thrice' });
    abortRebaseMock.mockResolvedValue('git exited with code 1');
    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).rejects.toThrow(
      'Could not complete rebase onto origin/main after 3 conflict resolution attempts.\ncontinue failed thrice\nA best-effort git rebase --abort also failed: git exited with code 1'
    );

    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it('does not treat hook keywords in the branch name as hook failures', async () => {
    getCurrentBranchMock.mockResolvedValue('shipper/456-feed-pre-push-hook-failures');
    remoteRefExistsMock.mockResolvedValue(true);
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // initial rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: 'attempt 1', stderr: 'non-fast-forward' }) // push
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // recovery rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }); // push

    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(fetchOriginOrThrowMock).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[1]?.[1]).toContain(
      'git push --force-with-lease origin HEAD:refs/heads/shipper/456-feed-pre-push-hook-failures exited with code 1:\nnon-fast-forward\nattempt 1'
    );
  });

  it('shares the push retry budget across hook and non-hook remediation attempts', async () => {
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // initial rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: 'attempt 1', stderr: 'lefthook pre-push failed' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: 'attempt 2', stderr: 'non-fast-forward' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: 'attempt 3', stderr: 'overcommit pre-push failed' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: 'attempt 4', stderr: 'non-fast-forward' });

    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).rejects.toThrow(
      'Push failed after 3 retry attempts.\ngit push --force-with-lease origin HEAD:refs/heads/feature/retry exited with code 1:\nnon-fast-forward\nattempt 4'
    );

    expect(fetchOriginOrThrowMock).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledTimes(4);
  });

  it('surfaces recovery fetch failures immediately as transport errors', async () => {
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // initial rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'non-fast-forward' }); // push
    fetchOriginOrThrowMock.mockRejectedValue(
      new Error('Git transport failed in /tmp/wt for repo /tmp/repo: git fetch origin failed: boom')
    );

    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).rejects.toThrow(
      'Git transport failed in /tmp/wt for repo /tmp/repo: git fetch origin failed: boom'
    );

    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('returns the recovery conflict-resolution agent exit code without retrying push again', async () => {
    remoteRefExistsMock.mockResolvedValue(true);
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // initial rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'non-fast-forward' }) // push
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'merge conflict' }); // recovery rebase

    const runAgent = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(2);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).resolves.toBe(2);

    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('continues retrying push after push-error remediation returns a non-zero exit code', async () => {
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // initial rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({
        code: 1,
        stdout: 'npm test',
        stderr: 'simple-git-hooks pre-push failed',
      })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }); // push

    const runAgent = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(17);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('feeds failed recovery rebase --continue output into the next retry context', async () => {
    remoteRefExistsMock.mockResolvedValue(true);
    buildConflictContextMock.mockResolvedValueOnce({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nresolved-ish\n=======\nincoming\n>>>>>>> origin/feature/retry'],
        },
      ],
      continueError: 'still conflicted after continue',
    });
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // initial rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'non-fast-forward' }) // push
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'merge conflict' }) // recovery rebase
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'still conflicted after continue' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // rebase --continue
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }); // push

    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent.mock.calls[2]?.[0]).toMatchObject({
      continueError: 'still conflicted after continue',
    });
  });

  it('aborts the rebase before throwing when recovery continue fails without unresolved files', async () => {
    remoteRefExistsMock.mockResolvedValue(true);
    buildConflictContextMock.mockResolvedValueOnce(undefined);
    isRebaseCompleteMock.mockResolvedValueOnce(false);
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // initial rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'non-fast-forward' }) // push
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'merge conflict' }) // recovery rebase
      .mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'No changes - did you forget to use git add?',
      });

    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).rejects.toThrow('git rebase --continue failed without unresolved files.');

    expect(abortRebaseMock).toHaveBeenCalledWith('/tmp/wt');
  });

  it('recovers and pushes when the agent already completed the recovery rebase', async () => {
    remoteRefExistsMock.mockResolvedValue(true);
    buildConflictContextMock.mockResolvedValueOnce(undefined);
    isRebaseCompleteMock.mockResolvedValueOnce(true);
    execAsyncMock
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // initial rebase
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'non-fast-forward' }) // push
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'merge conflict' }) // recovery rebase
      .mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'No changes - did you forget to use git add?',
      })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }) // clean
      .mockResolvedValueOnce({ code: 0, stdout: '.git/hooks\n', stderr: '' }) // hooks path
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' }); // push

    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(3);
  });
});
