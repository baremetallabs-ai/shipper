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

const { pushWorktree } = await import('../../src/lib/worktree.js');
const protectedPathsArgs = [
  'ls-files',
  '--',
  '.shipper/output/',
  '.shipper/input/',
  '.shipper/tmp/',
];
const resetIndexArgs = ['reset', 'HEAD', '--', '.'];
const checkoutArgs = ['checkout', 'HEAD', '--', '.'];
const cleanArgs = ['clean', '-fd', '--exclude=.shipper'];

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

function queueProtectedPathsLsFiles(stdout = ''): void {
  queueExecResult({ stdout });
}

function queueCleanBeforePush(): void {
  queueProtectedPathsLsFiles();
  queueExecResult();
  queueExecResult();
}

function queueCleanBeforeForcePush(commitsAhead = '1\n'): void {
  queueExecResult({ stdout: commitsAhead });
  queueCleanBeforePush();
}

function cleanBeforePushGitArgs(): string[][] {
  return [protectedPathsArgs, checkoutArgs, cleanArgs];
}

function cleanBeforeForcePushGitArgs(_commitsAhead = '1\n'): string[][] {
  return [['rev-list', '--count', 'origin/main..HEAD'], ...cleanBeforePushGitArgs()];
}

function gitArgsFromSpawnCalls(): string[][] {
  return spawnMock.mock.calls.map(([, args]) => args ?? []);
}

function gitArgsFromExecCalls(): string[][] {
  return execFileMock.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args);
}

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
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
    expect(execFileMock.mock.calls[2]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(execFileMock.mock.calls[3]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(gitArgsFromExecCalls()).not.toContainEqual(['rev-list', '--count', 'origin/main..HEAD']);
  });

  it('aborts before push when git checkout -- . fails', async () => {
    queueProtectedPathsLsFiles();
    queueExecResult({ code: 1, stderr: 'checkout failed' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).rejects.toThrow('Failed to clean tracked files before push');

    expect(gitArgsFromExecCalls()).toEqual([protectedPathsArgs, checkoutArgs]);
  });

  it('aborts before push when git clean -fd --exclude=.shipper fails', async () => {
    queueProtectedPathsLsFiles();
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

    expect(gitArgsFromExecCalls()).toEqual([...cleanBeforePushGitArgs()]);
  });

  it('fetches, rebases onto the remote branch, and force-pushes after a failed new-branch push', async () => {
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: 'abc123\n' });
    queueExecResult();
    queueCleanBeforeForcePush();
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
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ...cleanBeforeForcePushGitArgs(),
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
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
  });

  it('aborts and throws when the recovery rebase fails, preserving any abort failure detail', async () => {
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforeForcePush();
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
    queueCleanBeforeForcePush();
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
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
  });

  it('stops after three recovery attempts and throws the final push failure', async () => {
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 1' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 2' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 3' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforeForcePush();
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
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
  });

  it('refuses to force-push when the branch has no commits ahead of the base branch', async () => {
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: '0\n' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      })
    ).rejects.toThrow('Refusing to push: branch has 0 commits ahead of base branch');

    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-list', '--count', 'origin/main..HEAD'],
    ]);
  });

  it('continues force-push checkout, clean, and push when the branch is ahead of the base branch', async () => {
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforeForcePush('3\n');
    queueExecResult();

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      })
    ).resolves.toBeUndefined();

    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs('3\n'),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('logs and proceeds with force-push when the commit-count safety check fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      queueExecResult({ stdout: 'feature/retry\n' });
      queueExecResult({ code: 128, stderr: 'fatal: bad revision' });
      queueCleanBeforePush();
      queueExecResult();

      await expect(
        pushWorktree({
          wtPath: '/tmp/wt',
          repoRoot: '/tmp/repo',
          baseBranch: 'main',
          pushMode: 'force-with-lease',
        })
      ).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[shipper] Commit-count safety check failed before force-push; proceeding with push.\n' +
          'git rev-list --count origin/main..HEAD exited with code 128:\n' +
          'fatal: bad revision'
      );
      expect(gitArgsFromExecCalls()).toEqual([
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        ['rev-list', '--count', 'origin/main..HEAD'],
        ...cleanBeforePushGitArgs(),
        ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ]);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('re-checks the commit count before retrying a force-push attempt', async () => {
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueExecResult({ stdout: '0\n' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      })
    ).rejects.toThrow('Refusing to push: branch has 0 commits ahead of base branch');

    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rev-list', '--count', 'origin/main..HEAD'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
  });

  it('strips tracked protected files, amends HEAD, and then pushes', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      queueProtectedPathsLsFiles(
        [
          '.shipper/output/result.json',
          '.shipper/output/.gitkeep',
          '.shipper/input/request.json',
          '.shipper/tmp/debug.log',
        ].join('\n')
      );
      queueExecResult();
      queueProtectedPathsLsFiles(
        [
          '.shipper/output/result.json',
          '.shipper/output/.gitkeep',
          '.shipper/input/request.json',
          '.shipper/tmp/debug.log',
        ].join('\n')
      );
      queueExecResult();
      queueExecResult();
      queueExecResult();
      queueExecResult();
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
        protectedPathsArgs,
        resetIndexArgs,
        protectedPathsArgs,
        [
          'rm',
          '--cached',
          '--',
          '.shipper/output/result.json',
          '.shipper/input/request.json',
          '.shipper/tmp/debug.log',
        ],
        ['commit', '--amend', '--allow-empty', '--no-edit', '--no-verify', '--no-gpg-sign'],
        checkoutArgs,
        cleanArgs,
        ['push', '-u', 'origin', 'HEAD'],
      ]);
      expect(execFileMock.mock.calls[4]?.[2]).toMatchObject({
        cwd: '/tmp/wt',
      });
      expect(execFileMock.mock.calls[4]?.[2]).toHaveProperty('env.GIT_EDITOR', 'true');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[shipper] Stripped 3 tracked .shipper/ artifact files from git index before push'
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('no-ops when no protected files are tracked before push', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
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
        ...cleanBeforePushGitArgs(),
        ['push', '-u', 'origin', 'HEAD'],
      ]);
      const rmCachedCalls = gitArgsFromExecCalls().filter(
        (args) => args[0] === 'rm' && args[1] === '--cached'
      );
      expect(rmCachedCalls).toHaveLength(0);
      expect(gitArgsFromExecCalls()).not.toContainEqual([
        'commit',
        '--amend',
        '--allow-empty',
        '--no-edit',
        '--no-verify',
        '--no-gpg-sign',
      ]);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('preserves .gitkeep while stripping other tracked protected files', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      queueProtectedPathsLsFiles(
        ['.shipper/output/.gitkeep', '.shipper/input/.gitkeep', '.shipper/output/result.json'].join(
          '\n'
        )
      );
      queueExecResult();
      queueProtectedPathsLsFiles(
        ['.shipper/output/.gitkeep', '.shipper/input/.gitkeep', '.shipper/output/result.json'].join(
          '\n'
        )
      );
      queueExecResult();
      queueExecResult();
      queueExecResult();
      queueExecResult();
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
        protectedPathsArgs,
        resetIndexArgs,
        protectedPathsArgs,
        ['rm', '--cached', '--', '.shipper/output/result.json'],
        ['commit', '--amend', '--allow-empty', '--no-edit', '--no-verify', '--no-gpg-sign'],
        checkoutArgs,
        cleanArgs,
        ['push', '-u', 'origin', 'HEAD'],
      ]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[shipper] Stripped 1 tracked .shipper/ artifact files from git index before push'
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('resets the index before push and skips amend when only staged protected files were present', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      queueProtectedPathsLsFiles('.shipper/output/result.json');
      queueExecResult();
      queueProtectedPathsLsFiles();
      queueExecResult();
      queueExecResult();
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
        protectedPathsArgs,
        resetIndexArgs,
        protectedPathsArgs,
        checkoutArgs,
        cleanArgs,
        ['push', '-u', 'origin', 'HEAD'],
      ]);
      expect(gitArgsFromExecCalls()).not.toContainEqual([
        'commit',
        '--amend',
        '--allow-empty',
        '--no-edit',
        '--no-verify',
        '--no-gpg-sign',
      ]);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('aborts before push when git ls-files fails', async () => {
    queueExecResult({ code: 1, stderr: 'ls-files failed' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).rejects.toThrow('git ls-files -- .shipper/output/ .shipper/input/ .shipper/tmp/');

    expect(gitArgsFromExecCalls()).toEqual([protectedPathsArgs]);
  });
});
