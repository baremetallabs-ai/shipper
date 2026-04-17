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
const accessMock = vi.fn<(path: string, mode?: number) => Promise<void>>();
const chmodMock = vi.fn<(path: string, mode: number) => Promise<void>>();
const mkdtempMock = vi.fn<(prefix: string) => Promise<string>>();
const rmMock = vi.fn<(path: string, opts: Record<string, unknown>) => Promise<void>>();
const writeFileMock = vi.fn<(path: string, content: string) => Promise<void>>();
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
    chmod: (...args: unknown[]) => chmodMock(...args),
    mkdtemp: (...args: unknown[]) => mkdtempMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
    rm: (...args: unknown[]) => rmMock(...args),
    access: (...args: unknown[]) => accessMock(...args),
    writeFile: (...args: unknown[]) => writeFileMock(...args),
  };
});

vi.mock('../../src/lib/hooks.js', () => ({
  runAdvisoryHook: vi.fn(),
  runWorktreeHook: vi.fn(),
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => getSettingsMock(),
}));

const { syncWorktree, withGitTransport } = await import('../../src/lib/worktree.js');
const protectedPathsArgs = [
  'ls-files',
  '--',
  '.shipper/output/',
  '.shipper/input/',
  '.shipper/tmp/',
];
const checkoutArgs = ['checkout', 'HEAD', '--', '.'];
const cleanArgs = ['clean', '-fd', '--exclude=.shipper'];
const hooksPathArgs = ['rev-parse', '--git-path', 'hooks'];

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

function queueExecProcessError(opts: {
  message: string;
  code?: string;
  stdout?: string;
  stderr?: string;
}): void {
  const { message, code = 'ERR_CHILD_PROCESS', stdout = '', stderr = '' } = opts;
  execFileMock.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _execOpts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      globalThis.queueMicrotask(() => {
        const error = new Error(message) as Error & {
          code?: string;
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

function queueHooksPath(stdout = '/tmp/repo/.git/hooks\n'): void {
  queueExecResult({ stdout });
}

function queueCleanBeforePush(): void {
  queueProtectedPathsLsFiles();
  queueExecResult();
  queueExecResult();
  queueHooksPath();
}

function queueCleanBeforeForcePush(commitsAhead = '1\n'): void {
  queueExecResult({ stdout: commitsAhead });
  queueCleanBeforePush();
}

function cleanBeforePushGitArgs(): string[][] {
  return [protectedPathsArgs, checkoutArgs, cleanArgs, hooksPathArgs];
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
    maxBuffer: Number.POSITIVE_INFINITY,
  });
}

describe('syncWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    chmodMock.mockResolvedValue(undefined);
    mkdtempMock.mockResolvedValue('/tmp/shipper-pre-push-wrapper');
    rmMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    getSettingsMock.mockReset();
    getSettingsMock.mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reruns installCommand after a clean rebase before returning', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
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
    expectInstallExec(3);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('stages resolved files before rebase --continue and reruns installCommand after conflict resolution', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
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
    expectInstallExec(6);
    const gitArgs = gitArgsFromExecCalls();
    expect(gitArgs.slice(3, 6)).toEqual([
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
    ]);
    expect(gitArgs).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
    ]);
  });

  it('reruns installCommand when rebase --continue reports failure but the rebase is already complete', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult();
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
    expectInstallExec(8);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rev-parse', '--git-dir'],
    ]);
  });

  it('skips the post-rebase install when no installCommand is configured', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
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
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('passes install failure output to the remediation callback and retries successfully', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
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
    expectInstallExec(3);
    expectInstallExec(4);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('passes message-only install process failures to the remediation callback', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
    queueExecResult();
    queueExecProcessError({
      message: 'stdout maxBuffer length exceeded',
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
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
    expect(remediateInstallError).toHaveBeenCalledWith(
      'npm ci exited with code 1:\nstdout maxBuffer length exceeded'
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expectFetchSpawn();
    expectInstallExec(3);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('throws when the install remediation callback exits non-zero', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
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
    expectInstallExec(3);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('throws after three unsuccessful install remediation attempts with the final output', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
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
    expectInstallExec(3);
    expectInstallExec(4);
    expectInstallExec(5);
    expectInstallExec(6);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('throws on the first install failure when no remediation callback is provided', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists → not found
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
    expectInstallExec(3);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('resets to remote branch before rebasing when origin/{currentBranch} exists', async () => {
    queueSpawnExit(); // fetch origin
    queueExecResult({ stdout: 'feature/my-branch\n' }); // getCurrentBranch
    queueExecResult({ stdout: 'abc123\n' }); // remoteRefExists → found
    queueExecResult(); // reset --hard origin/feature/my-branch
    queueExecResult(); // rebase --autostash origin/main
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
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/my-branch'],
      ['reset', '--hard', 'origin/feature/my-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('throws when reset to remote branch fails', async () => {
    queueSpawnExit(); // fetch origin
    queueExecResult({ stdout: 'feature/my-branch\n' }); // getCurrentBranch
    queueExecResult({ stdout: 'abc123\n' }); // remoteRefExists → found
    queueExecResult({ code: 1, stderr: 'error: could not reset' }); // reset --hard fails
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
    ).rejects.toThrow('Failed to sync with remote branch origin/feature/my-branch');

    expect(resolveConflicts).not.toHaveBeenCalled();
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
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
    expectInstallExec(3);
    expect(execFileMock.mock.invocationCallOrder[3]).toBeLessThan(
      runAgent.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
    expect(execFileMock.mock.calls[8]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
      maxBuffer: 10 * 1024 * 1024,
    });
  });

  it('still pushes after a clean rebase when the initial agent exit code is non-zero', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('skips the post-rebase install when no installCommand is configured', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('reruns installCommand after rebase --continue succeeds before push resumes', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
    queueCleanBeforeForcePush();
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
    expectInstallExec(6);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('fetches, rebases onto the remote feature branch, and force-pushes after a failed new-branch push', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward', stdout: 'remote rejected' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ stdout: 'abc123\n' });
    queueExecResult();
    queueCleanBeforeForcePush();
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

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls).toEqual([
      [],
      [undefined, 'git push -u origin HEAD exited with code 1:\nnon-fast-forward\nremote rejected'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('skips the recovery rebase and retries the original push args when the remote branch does not exist', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls).toEqual([
      [],
      [undefined, 'git push -u origin HEAD exited with code 1:\ntemporary push failure'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('re-enters conflict resolution when the recovery rebase hits conflicts', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
    queueExecResult();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforeForcePush();
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
    queueCleanBeforeForcePush();
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
    expect(runAgent.mock.calls[2]).toEqual([
      undefined,
      'git push --force-with-lease origin HEAD:refs/heads/feature/retry exited with code 1:\nnon-fast-forward',
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('passes conflicts without inline markers through to the agent', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
    queueExecResult();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforeForcePush();
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
    queueCleanBeforeForcePush();
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

    expect(runAgent).toHaveBeenCalledTimes(4);
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
    expect(runAgent.mock.calls[3]).toEqual([
      undefined,
      'git push --force-with-lease origin HEAD:refs/heads/feature/retry exited with code 1:\nnon-fast-forward',
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs(),
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
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('returns the recovery conflict-resolution agent exit code without retrying push again', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ['rebase', '--autostash', 'origin/feature/retry'],
      ['diff', '--name-only', '--diff-filter=U'],
    ]);
  });

  it('surfaces recovery fetch failures immediately as transport errors', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
    queueExecResult();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforeForcePush();
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
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('throws the final captured push failure after exhausting push retries', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward', stdout: 'attempt 1' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward', stdout: 'attempt 2' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward', stdout: 'attempt 3' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward', stdout: 'attempt 4' });
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
      'Push failed after 3 retry attempts.\ngit push -u origin HEAD exited with code 1:\nnon-fast-forward\nattempt 4'
    );

    expect(runAgent.mock.calls).toEqual([
      [],
      [undefined, 'git push -u origin HEAD exited with code 1:\nnon-fast-forward\nattempt 1'],
      [undefined, 'git push -u origin HEAD exited with code 1:\nnon-fast-forward\nattempt 2'],
      [undefined, 'git push -u origin HEAD exited with code 1:\nnon-fast-forward\nattempt 3'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('skips fetch/rebase recovery for recognized hook failures and retries the original push args', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
    queueExecResult();
    queueCleanBeforePush();
    queueExecResult({
      code: 1,
      stderr: 'husky - pre-push hook exited with code 1',
      stdout: 'npm run lint',
    });
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

    expect(runAgent.mock.calls).toEqual([
      [],
      [
        undefined,
        'git push -u origin HEAD exited with code 1:\nhusky - pre-push hook exited with code 1\nnpm run lint',
      ],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('continues retrying push after push-error remediation returns a non-zero exit code', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queueSpawnExit();
      queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
      queueExecResult({ code: 128 }); // remoteRefExists
      queueExecResult();
      queueCleanBeforePush();
      queueExecResult({
        code: 1,
        stderr: 'simple-git-hooks pre-push failed',
        stdout: 'npm test',
      });
      queueCleanBeforePush();
      queueExecResult();
      const runAgent = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(17);

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

      expect(runAgent.mock.calls).toEqual([
        [],
        [
          undefined,
          'git push -u origin HEAD exited with code 1:\nsimple-git-hooks pre-push failed\nnpm test',
        ],
      ]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[shipper] Agent exited with code 17 while handling push failure; retrying.'
      );
      expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
      expect(gitArgsFromExecCalls()).toEqual([
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        ['rev-parse', '--verify', 'origin/feature/test-branch'],
        ['rebase', '--autostash', 'origin/main'],
        ...cleanBeforePushGitArgs(),
        ['push', '-u', 'origin', 'HEAD'],
        ...cleanBeforePushGitArgs(),
        ['push', '-u', 'origin', 'HEAD'],
      ]);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not treat hook keywords in the branch name as hook failures', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
    queueExecResult();
    queueExecResult({ stdout: 'shipper/456-feed-pre-push-hook-failures-back-to-the-agent-inst\n' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward', stdout: 'attempt 1' });
    queueSpawnExit();
    queueExecResult({ stdout: 'shipper/456-feed-pre-push-hook-failures-back-to-the-agent-inst\n' });
    queueExecResult({
      stdout: 'abc123\n',
    });
    queueExecResult();
    queueCleanBeforeForcePush();
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

    expect(runAgent.mock.calls).toEqual([
      [],
      [
        undefined,
        'git push --force-with-lease origin HEAD:refs/heads/shipper/456-feed-pre-push-hook-failures-back-to-the-agent-inst exited with code 1:\nnon-fast-forward\nattempt 1',
      ],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs(),
      [
        'push',
        '--force-with-lease',
        'origin',
        'HEAD:refs/heads/shipper/456-feed-pre-push-hook-failures-back-to-the-agent-inst',
      ],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      [
        'rev-parse',
        '--verify',
        'origin/shipper/456-feed-pre-push-hook-failures-back-to-the-agent-inst',
      ],
      [
        'rebase',
        '--autostash',
        'origin/shipper/456-feed-pre-push-hook-failures-back-to-the-agent-inst',
      ],
      ...cleanBeforeForcePushGitArgs(),
      [
        'push',
        '--force-with-lease',
        'origin',
        'HEAD:refs/heads/shipper/456-feed-pre-push-hook-failures-back-to-the-agent-inst',
      ],
    ]);
  });

  it('shares the push retry budget across hook and non-hook remediation attempts', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
    queueExecResult();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'lefthook pre-push failed', stdout: 'attempt 1' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward', stdout: 'attempt 2' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/retry\n' });
    queueExecResult({ code: 1, stderr: 'fatal: Needed a single revision' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'overcommit pre-push failed', stdout: 'attempt 3' });
    queueCleanBeforeForcePush();
    queueExecResult({ code: 1, stderr: 'non-fast-forward', stdout: 'attempt 4' });
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

    expect(runAgent.mock.calls).toEqual([
      [],
      [
        undefined,
        'git push --force-with-lease origin HEAD:refs/heads/feature/retry exited with code 1:\nlefthook pre-push failed\nattempt 1',
      ],
      [
        undefined,
        'git push --force-with-lease origin HEAD:refs/heads/feature/retry exited with code 1:\nnon-fast-forward\nattempt 2',
      ],
      [
        undefined,
        'git push --force-with-lease origin HEAD:refs/heads/feature/retry exited with code 1:\novercommit pre-push failed\nattempt 3',
      ],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['fetch', 'origin'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/retry'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('returns the agent exit code without continuing the rebase or pushing when conflict resolution fails', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
    ]);
  });

  it('aborts the rebase after three failed conflict-resolution attempts', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
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
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
    queueCleanBeforeForcePush();
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
    expectInstallExec(8);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['add', '-u'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rev-parse', '--git-dir'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ...cleanBeforeForcePushGitArgs(),
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/feature/retry'],
    ]);
  });

  it('passes install failure output to the agent, retries, and continues before push', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
    expectInstallExec(3);
    expectInstallExec(4);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('returns the install remediation agent exit code before the main agent runs', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
    expectInstallExec(3);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('throws after three unsuccessful install remediation attempts with the final output', async () => {
    getSettingsMock.mockReturnValue({ installCommand: 'npm ci' });
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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
    expectInstallExec(3);
    expectInstallExec(4);
    expectInstallExec(5);
    expectInstallExec(6);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/test-branch'],
      ['rebase', '--autostash', 'origin/main'],
    ]);
  });

  it('preserves the transport failure when rebase abort also fails', async () => {
    queueSpawnExit();
    queueExecResult({ stdout: 'feature/test-branch\n' }); // getCurrentBranch
    queueExecResult({ code: 128 }); // remoteRefExists
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

  it('resets to remote branch before rebasing when origin/{currentBranch} exists', async () => {
    queueSpawnExit(); // fetch origin
    queueExecResult({ stdout: 'feature/my-branch\n' }); // getCurrentBranch
    queueExecResult({ stdout: 'abc123\n' }); // remoteRefExists → found
    queueExecResult(); // reset --hard origin/feature/my-branch
    queueExecResult(); // rebase --autostash origin/main
    queueCleanBeforePush();
    queueExecResult(); // push
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
    expect(gitArgsFromExecCalls()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--verify', 'origin/feature/my-branch'],
      ['reset', '--hard', 'origin/feature/my-branch'],
      ['rebase', '--autostash', 'origin/main'],
      ...cleanBeforePushGitArgs(),
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('throws when reset to remote branch fails', async () => {
    queueSpawnExit(); // fetch origin
    queueExecResult({ stdout: 'feature/my-branch\n' }); // getCurrentBranch
    queueExecResult({ stdout: 'abc123\n' }); // remoteRefExists → found
    queueExecResult({ code: 1, stderr: 'error: could not reset' }); // reset --hard fails
    const runAgent = vi.fn();

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
    ).rejects.toThrow('Failed to sync with remote branch origin/feature/my-branch');

    expect(runAgent).not.toHaveBeenCalled();
  });
});
