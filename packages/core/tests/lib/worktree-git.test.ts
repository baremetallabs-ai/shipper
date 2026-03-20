import { EventEmitter } from 'node:events';
import type { Settings } from '../../src/lib/settings.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock =
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => EventEmitter>();
const execFileMock =
  vi.fn<
    (
      command: string,
      args: string[],
      execOpts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => object
  >();
const readFileMock = vi.fn<(path: string, encoding: string) => Promise<string>>();
const accessMock = vi.fn<(path: string) => Promise<void>>();
const getSettingsMock = vi.fn<() => Pick<Settings, 'installCommand'>>();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: (...args: unknown[]) => readFileMock(...args),
    access: (...args: unknown[]) => accessMock(...args),
  };
});

vi.mock('../../src/lib/hooks.js', () => ({
  runAdvisoryHook: vi.fn(),
  runWorktreeHook: vi.fn(),
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => getSettingsMock(),
}));

const { formatConflictContext, pushWorktree, syncWorktree, withGitTransport } =
  await import('../../src/lib/worktree.js');

function queueSpawnExit(code = 0): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter();
    globalThis.queueMicrotask(() => {
      child.emit('close', code);
    });
    return child;
  });
}

function queueExecResult(opts: { code?: number; stdout?: string; stderr?: string } = {}): void {
  const { code = 0, stdout = '', stderr = '' } = opts;
  execFileMock.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _execOpts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      globalThis.queueMicrotask(() => {
        if (code === 0) {
          callback(null, stdout, stderr);
          return;
        }

        const error = new Error(`exit:${code}`) as Error & {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        callback(error, stdout, stderr);
      });
      return {} as object;
    }
  );
}

function queueCleanBeforePush(): void {
  queueExecResult();
  queueExecResult();
}

function gitArgsFromSpawnCalls(): string[][] {
  return spawnMock.mock.calls.map(([, args]) => args ?? []);
}

function gitArgsFromExecCalls(): string[][] {
  return execFileMock.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args);
}

function expectFetchSpawn(callIndex = 0): void {
  expect(spawnMock.mock.calls[callIndex]?.[0]).toBe('git');
  expect(spawnMock.mock.calls[callIndex]?.[1]).toEqual(['fetch', 'origin']);
  expect(spawnMock.mock.calls[callIndex]?.[2]).toMatchObject({
    cwd: '/tmp/wt',
    stdio: 'inherit',
  });
}

function expectInstallExec(callIndex: number): void {
  expect(execFileMock.mock.calls[callIndex]?.[0]).toBe('npm ci');
  expect(execFileMock.mock.calls[callIndex]?.[1]).toEqual([]);
  expect(execFileMock.mock.calls[callIndex]?.[2]).toMatchObject({
    cwd: '/tmp/wt',
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe('syncWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    getSettingsMock.mockReset();
    getSettingsMock.mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reruns installCommand after a clean rebase before returning', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult();
    const resolveConflicts = vi.fn();

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts
      )
    ).resolves.toBeUndefined();

    expect(resolveConflicts).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });

  it('reruns installCommand after rebase --continue succeeds in conflict resolution', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\nREADME.md\n' });
    readFileMock
      .mockResolvedValueOnce(
        ['start', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> origin/main', 'end'].join(
          '\n'
        )
      )
      .mockResolvedValueOnce(
        ['<<<<<<< HEAD', 'left', '=======', 'right', '>>>>>>> origin/main'].join('\n')
      );
    queueExecResult();
    queueExecResult();
    const resolveConflicts = vi.fn().mockResolvedValue(0);

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts
      )
    ).resolves.toBeUndefined();

    expect(resolveConflicts).toHaveBeenCalledTimes(1);
    expect(resolveConflicts).toHaveBeenCalledWith({
      files: ['src/conflict.ts', 'README.md'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
        {
          path: 'README.md',
          markers: ['<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> origin/main'],
        },
      ],
      continueError: undefined,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(3);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
    ]);
  });

  it('reruns installCommand when rebase --continue reports failure but the rebase is already complete', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult({ code: 1, stderr: 'No changes - did you forget to use git add?' });
    queueExecResult({ stdout: '' });
    queueExecResult({ stdout: '.git\n' });
    queueExecResult();
    const resolveConflicts = vi.fn().mockResolvedValue(0);

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts
      )
    ).resolves.toBeUndefined();

    expect(resolveConflicts).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(5);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rev-parse', '--git-dir'],
    ]);
  });

  it('skips the post-rebase install when no installCommand is configured', async () => {
    queueSpawnExit();
    queueExecResult();
    const resolveConflicts = vi.fn();
    const remediateInstallError = vi.fn();

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts,
        remediateInstallError
      )
    ).resolves.toBeUndefined();

    expect(resolveConflicts).not.toHaveBeenCalled();
    expect(remediateInstallError).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });

  it('passes install failure output to the remediation callback and retries successfully', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'lock mismatch', stdout: 'npm notice' });
    queueExecResult();
    const resolveConflicts = vi.fn();
    const remediateInstallError = vi.fn().mockResolvedValue(0);

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts,
        remediateInstallError
      )
    ).resolves.toBeUndefined();

    expect(resolveConflicts).not.toHaveBeenCalled();
    expect(remediateInstallError).toHaveBeenCalledTimes(1);
    expect(remediateInstallError).toHaveBeenCalledWith(
      'npm ci exited with code 1:\nlock mismatch\nnpm notice'
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expectInstallExec(2);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });

  it('throws when the install remediation callback exits non-zero', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'lock mismatch' });
    const resolveConflicts = vi.fn();
    const remediateInstallError = vi.fn().mockResolvedValue(9);

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts,
        remediateInstallError
      )
    ).rejects.toThrow(
      'Git transport failed in /tmp/wt for repo /tmp/repo: Install remediation agent exited with code 9'
    );

    expect(resolveConflicts).not.toHaveBeenCalled();
    expect(remediateInstallError).toHaveBeenCalledWith('npm ci exited with code 1:\nlock mismatch');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });

  it('throws after three unsuccessful install remediation attempts with the final output', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'attempt 1 stderr', stdout: 'attempt 1 stdout' });
    queueExecResult({ code: 1, stderr: 'attempt 2 stderr', stdout: 'attempt 2 stdout' });
    queueExecResult({ code: 1, stderr: 'attempt 3 stderr', stdout: 'attempt 3 stdout' });
    queueExecResult({ code: 1, stderr: 'attempt 4 stderr', stdout: 'attempt 4 stdout' });
    const resolveConflicts = vi.fn();
    const remediateInstallError = vi.fn().mockResolvedValue(0);

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts,
        remediateInstallError
      )
    ).rejects.toThrow(
      'Post-rebase install failed after 3 remediation attempts:\nnpm ci exited with code 1:\nattempt 4 stderr\nattempt 4 stdout'
    );

    expect(resolveConflicts).not.toHaveBeenCalled();
    expect(remediateInstallError).toHaveBeenCalledTimes(3);
    expect(remediateInstallError).toHaveBeenNthCalledWith(
      1,
      'npm ci exited with code 1:\nattempt 1 stderr\nattempt 1 stdout'
    );
    expect(remediateInstallError).toHaveBeenNthCalledWith(
      2,
      'npm ci exited with code 1:\nattempt 2 stderr\nattempt 2 stdout'
    );
    expect(remediateInstallError).toHaveBeenNthCalledWith(
      3,
      'npm ci exited with code 1:\nattempt 3 stderr\nattempt 3 stdout'
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expectInstallExec(2);
    expectInstallExec(3);
    expectInstallExec(4);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });

  it('throws on the first install failure when no remediation callback is provided', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'lock mismatch', stdout: 'npm notice' });
    const resolveConflicts = vi.fn();

    await expect(
      syncWorktree(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        },
        resolveConflicts
      )
    ).rejects.toThrow(
      'Post-rebase install failed:\nnpm ci exited with code 1:\nlock mismatch\nnpm notice'
    );

    expect(resolveConflicts).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });
});

describe('pushWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('pushes a new branch without invoking any agent callback', async () => {
    queueCleanBeforePush();
    queueExecResult();

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).resolves.toBeUndefined();

    expect(gitArgsFromExecCalls()).toEqual([
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
    expect(execFileMock.mock.calls[1]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(execFileMock.mock.calls[2]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
      maxBuffer: 10 * 1024 * 1024,
    });
  });

  it('aborts before push when git checkout -- . fails', async () => {
    queueExecResult({ code: 1, stderr: 'checkout failed' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).rejects.toThrow('Failed to clean tracked files before push');

    expect(gitArgsFromExecCalls()).toEqual([['checkout', '--', '.']]);
  });

  it('aborts before push when git clean -fd --exclude=.shipper fails', async () => {
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'clean failed' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).rejects.toThrow('Failed to remove untracked files before push');

    expect(gitArgsFromExecCalls()).toEqual([
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
    ]);
  });

  it('fetches, rebases onto the remote branch, and force-pushes after a failed new-branch push', async () => {
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: 'abc123\n' });
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult();

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).resolves.toBeUndefined();

    expect(gitArgsFromExecCalls()).toEqual([
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
  });

  it('skips the recovery rebase and retries the original push args when the remote branch does not exist', async () => {
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'temporary push failure' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult();

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).resolves.toBeUndefined();

    expect(gitArgsFromExecCalls()).toEqual([
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
  });

  it('aborts and throws when the recovery rebase fails, preserving any abort failure detail', async () => {
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: 'abc123\n' });
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueSpawnExit(1);

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

    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['rebase', '--abort'],
    ]);
  });

  it('surfaces recovery fetch failures immediately', async () => {
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit(1);

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      })
    ).rejects.toThrow('git fetch origin failed: git exited with code 1');

    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
  });

  it('stops after three recovery attempts and throws the final push failure', async () => {
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 1' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 2' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 3' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 4' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      })
    ).rejects.toThrow(
      'git push --force-with-lease origin HEAD:refs/heads/feature/retry exited with code 1:\npre-push hook failed\nattempt 4'
    );

    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
  });
});

describe('withGitTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    getSettingsMock.mockReset();
    getSettingsMock.mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reruns installCommand after a clean rebase before the first agent invocation', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult();
    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledWith();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expect(execFileMock.mock.invocationCallOrder[1]).toBeLessThan(
      runAgent.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
    expect(execFileMock.mock.calls[4]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
      maxBuffer: 10 * 1024 * 1024,
    });
  });

  it('still pushes after a clean rebase when the initial agent exit code is non-zero', async () => {
    queueSpawnExit();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult();
    const runAgent = vi.fn().mockResolvedValue(2);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith();
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('skips the post-rebase install when no installCommand is configured', async () => {
    queueSpawnExit();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult();
    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('reruns installCommand after rebase --continue succeeds before push resumes', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\nREADME.md\n' });
    readFileMock
      .mockResolvedValueOnce(
        ['start', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> origin/main', 'end'].join(
          '\n'
        )
      )
      .mockResolvedValueOnce(
        ['<<<<<<< HEAD', 'left', '=======', 'right', '>>>>>>> origin/main'].join('\n')
      );
    queueExecResult();
    queueExecResult();
    queueExecResult();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforePush();
    queueExecResult();
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

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith({
      files: ['src/conflict.ts', 'README.md'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
        {
          path: 'README.md',
          markers: ['<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> origin/main'],
        },
      ],
      continueError: undefined,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(4);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('fetches, rebases onto the remote feature branch, and force-pushes after a failed new-branch push', async () => {
    queueSpawnExit();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'npm run lint' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: 'abc123\n' });
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult();
    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith();
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('skips the recovery rebase and retries the original push args when the remote branch does not exist', async () => {
    queueSpawnExit();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'temporary push failure' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult();
    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('re-enters conflict resolution when the recovery rebase hits conflicts', async () => {
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: 'abc123\n' });
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> origin/feature/retry'].join('\n')
    );
    queueExecResult();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult();
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

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]).toEqual([]);
    expect(runAgent.mock.calls[1]?.[0]).toEqual({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/feature/retry'],
        },
      ],
      continueError: undefined,
    });
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('passes conflicts without inline markers through to the agent', async () => {
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'assets/logo.png\ndeleted.txt\n' });
    readFileMock
      .mockResolvedValueOnce('not a text conflict file')
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const runAgent = vi.fn().mockResolvedValue(2);

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

    expect(runAgent).toHaveBeenCalledWith({
      files: ['assets/logo.png', 'deleted.txt'],
      conflicts: [
        {
          path: 'assets/logo.png',
          markers: [],
        },
        {
          path: 'deleted.txt',
          markers: [],
        },
      ],
      continueError: undefined,
    });
  });

  it('feeds a failed recovery rebase --continue error into the next retry context', async () => {
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: 'abc123\n' });
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/feature/retry'].join('\n')
    );
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'still conflicted after continue' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'resolved-ish', '=======', 'incoming', '>>>>>>> origin/feature/retry'].join(
        '\n'
      )
    );
    queueExecResult();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult();
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
    expect(runAgent.mock.calls[2]?.[0]).toEqual({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nresolved-ish\n=======\nincoming\n>>>>>>> origin/feature/retry'],
        },
      ],
      continueError: 'still conflicted after continue',
    });
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('returns the recovery conflict-resolution agent exit code without retrying push again', async () => {
    queueSpawnExit();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: 'abc123\n' });
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> origin/feature/retry'].join('\n')
    );
    const runAgent = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(2);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(2);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ['diff', '--name-only', '--diff-filter=U'],
    ]);
  });

  it('surfaces recovery fetch failures immediately as transport errors', async () => {
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit(1);
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
    ).rejects.toThrow('git fetch origin failed: git exited with code 1');

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('throws the final captured push failure after exhausting push retries', async () => {
    queueSpawnExit();
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 1' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 2' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 3' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 4' });
    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).rejects.toThrow(
      'Push failed after 3 retry attempts.\ngit push -u origin HEAD exited with code 1:\npre-push hook failed\nattempt 4'
    );

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('returns the agent exit code without continuing the rebase or pushing when conflict resolution fails', async () => {
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    const runAgent = vi.fn().mockResolvedValue(2);

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

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
    ]);
  });

  it('aborts the rebase after three failed conflict-resolution attempts', async () => {
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValue(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'continue failed once' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'continue failed twice' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'continue failed thrice' });
    queueSpawnExit();
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
      'Could not complete rebase onto origin/main after 3 conflict resolution attempts.'
    );

    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['rebase', '--abort'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
    ]);
  });

  it('aborts the rebase before throwing when rebase --continue fails without unresolved files and rebase is still in progress', async () => {
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'No changes - did you forget to use git add?' });
    queueExecResult({ stdout: '' });
    // git rev-parse --git-dir for isRebaseComplete
    queueExecResult({ stdout: '.git\n' });
    // rebase-merge dir exists → rebase still in progress
    accessMock.mockResolvedValueOnce(undefined);
    queueSpawnExit();
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

    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['rebase', '--abort'],
    ]);
  });

  it('recovers and pushes when agent commits during rebase and completes it', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    // git add -u (stageResolvedFiles)
    queueExecResult();
    // rebase --continue fails (agent already committed)
    queueExecResult({ code: 1, stderr: 'No changes - did you forget to use git add?' });
    // listConflictedFiles returns empty
    queueExecResult({ stdout: '' });
    // git rev-parse --git-dir for isRebaseComplete
    queueExecResult({ stdout: '.git\n' });
    // accessMock rejects by default (ENOENT) → no rebase dirs → rebase complete
    queueExecResult();
    // push (via execAsync, not spawnAsync)
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforePush();
    queueExecResult();
    const runAgent = vi.fn().mockResolvedValue(0);

    const code = await withGitTransport(
      {
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      },
      runAgent
    );

    expect(code).toBe(0);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(6);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rev-parse', '--git-dir'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('passes install failure output to the agent, retries, and continues before push', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'lock mismatch', stdout: 'npm notice' });
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult();
    const runAgent = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(0);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenNthCalledWith(
      1,
      undefined,
      undefined,
      'npm ci exited with code 1:\nlock mismatch\nnpm notice'
    );
    expect(runAgent).toHaveBeenNthCalledWith(2);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expectInstallExec(2);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['checkout', '--', '.'],
      ['clean', '-fd', '--exclude=.shipper'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('returns the install remediation agent exit code before the main agent runs', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'lock mismatch' });
    const runAgent = vi.fn().mockResolvedValue(7);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).resolves.toBe(7);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'npm ci exited with code 1:\nlock mismatch'
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });

  it('throws after three unsuccessful install remediation attempts with the final output', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'attempt 1 stderr', stdout: 'attempt 1 stdout' });
    queueExecResult({ code: 1, stderr: 'attempt 2 stderr', stdout: 'attempt 2 stdout' });
    queueExecResult({ code: 1, stderr: 'attempt 3 stderr', stdout: 'attempt 3 stdout' });
    queueExecResult({ code: 1, stderr: 'attempt 4 stderr', stdout: 'attempt 4 stdout' });
    const runAgent = vi.fn().mockResolvedValue(0);

    await expect(
      withGitTransport(
        {
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'new-branch',
        },
        runAgent
      )
    ).rejects.toThrow(
      'Post-rebase install failed after 3 remediation attempts:\nnpm ci exited with code 1:\nattempt 4 stderr\nattempt 4 stdout'
    );

    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(runAgent).toHaveBeenNthCalledWith(
      1,
      undefined,
      undefined,
      'npm ci exited with code 1:\nattempt 1 stderr\nattempt 1 stdout'
    );
    expect(runAgent).toHaveBeenNthCalledWith(
      2,
      undefined,
      undefined,
      'npm ci exited with code 1:\nattempt 2 stderr\nattempt 2 stdout'
    );
    expect(runAgent).toHaveBeenNthCalledWith(
      3,
      undefined,
      undefined,
      'npm ci exited with code 1:\nattempt 3 stderr\nattempt 3 stdout'
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(1);
    expectInstallExec(2);
    expectInstallExec(3);
    expectInstallExec(4);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });

  it('preserves the transport failure when rebase abort also fails', async () => {
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValue(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'continue failed once' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'continue failed twice' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'continue failed thrice' });
    queueSpawnExit(1);
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
  });
});

describe('formatConflictContext', () => {
  it('renders the file list, grouped markers, and prior continue error', () => {
    const formatted = formatConflictContext({
      files: ['src/conflict.ts', 'README.md'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
        {
          path: 'README.md',
          markers: ['<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> origin/main'],
        },
      ],
      continueError: 'No changes - did you forget to stage the resolved files?',
    });

    expect(formatted).toBe(
      [
        '## Merge Conflict Resolution Required',
        '',
        'The following files still have merge conflicts that must be resolved before the rebase can continue:',
        '',
        '- src/conflict.ts',
        '- README.md',
        '',
        'A previous `git rebase --continue` attempt failed with:',
        '',
        '```text',
        'No changes - did you forget to stage the resolved files?',
        '```',
        '',
        '### src/conflict.ts',
        '',
        '```diff',
        '<<<<<<< HEAD',
        'ours',
        '=======',
        'theirs',
        '>>>>>>> origin/main',
        '```',
        '',
        '### README.md',
        '',
        '```diff',
        '<<<<<<< HEAD',
        'left',
        '=======',
        'right',
        '>>>>>>> origin/main',
        '```',
        '',
        'Resolve all conflicts, then stage the resolved files with `git add`. Do not run `git commit`, `git rebase --continue`, `git rebase --abort`, or `git push` yourself.',
      ].join('\n')
    );
  });

  it('explains conflicts that do not have inline markers', () => {
    const formatted = formatConflictContext({
      files: ['assets/logo.png'],
      conflicts: [
        {
          path: 'assets/logo.png',
          markers: [],
        },
      ],
    });

    expect(formatted).toContain(
      'No inline conflict markers were found for this path. It may be a binary or delete/modify conflict. Resolve the file state directly, then stage it with `git add`.'
    );
  });
});
