// Scope: preserve only transport branches that depend on non-reproducible process-error shape or abort-detail handling.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execAsyncMock = vi.fn();
const spawnAsyncMock = vi.fn();
const syncWithRemoteBranchMock = vi.fn();
const getSettingsMock = vi.fn<() => { installCommand?: string }>();
const stageResolvedFilesMock = vi.fn();
const getConflictContextOrThrowMock = vi.fn();
const buildConflictContextMock = vi.fn();
const abortRebaseMock = vi.fn();

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
    stageResolvedFilesMock.mockResolvedValue(undefined);
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
});
