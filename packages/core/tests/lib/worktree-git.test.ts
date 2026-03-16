import { EventEmitter } from 'node:events';
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
  getSettings: vi.fn(() => ({})),
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

function gitArgsFromSpawnCalls(): string[][] {
  return spawnMock.mock.calls.map(([, args]) => args ?? []);
}

function gitArgsFromExecCalls(): string[][] {
  return execFileMock.mock.calls.map(([, args]) => args);
}

describe('syncWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and rebases without invoking conflict resolution on a clean rebase', async () => {
    queueSpawnExit();
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
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', '--autostash', 'origin/main']]);
  });

  it('passes conflict context through the conflict-resolution path and stops before push', async () => {
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
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
    ]);
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
    queueExecResult();

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      })
    ).resolves.toBeUndefined();

    expect(gitArgsFromExecCalls()).toEqual([['push', '-u', 'origin', 'HEAD']]);
    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
      maxBuffer: 10 * 1024 * 1024,
    });
  });

  it('retries failed force pushes and throws the terminal push error', async () => {
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 1' });
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 2' });
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 3' });
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 4' });

    await expect(
      pushWorktree({
        wtPath: '/tmp/wt',
        repoRoot: '/tmp/repo',
        baseBranch: 'main',
        pushMode: 'force-with-lease',
      })
    ).rejects.toThrow(
      'git push --force-with-lease exited with code 1:\npre-push hook failed\nattempt 4'
    );

    expect(gitArgsFromExecCalls()).toEqual([
      ['push', '--force-with-lease'],
      ['push', '--force-with-lease'],
      ['push', '--force-with-lease'],
      ['push', '--force-with-lease'],
    ]);
  });
});

describe('withGitTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches, runs the agent, and pushes a new branch after a clean rebase', async () => {
    queueSpawnExit();
    queueExecResult();
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
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
    expect(execFileMock.mock.calls[1]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
      maxBuffer: 10 * 1024 * 1024,
    });
  });

  it('passes grouped conflict markers to the agent and force-pushes after rebase continuation succeeds', async () => {
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
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['push', '--force-with-lease'],
    ]);
  });

  it('re-invokes the agent with push failure context after a clean rebase and retries the push', async () => {
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'npm run lint' });
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
        'git push -u origin HEAD exited with code 1:\npre-push hook failed\nnpm run lint',
      ],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['push', '-u', 'origin', 'HEAD'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('retries push failures after conflict resolution with push error context', async () => {
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed' });
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
    expect(runAgent.mock.calls[0]?.[0]).toEqual({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
      ],
      continueError: undefined,
    });
    expect(runAgent.mock.calls[1]).toEqual([
      undefined,
      'git push --force-with-lease exited with code 1:\npre-push hook failed',
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['push', '--force-with-lease'],
      ['push', '--force-with-lease'],
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

  it('feeds a failed rebase --continue error into the next retry context', async () => {
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult({ code: 1, stderr: 'still conflicted after continue' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'resolved-ish', '=======', 'incoming', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult();
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
    expect(runAgent.mock.calls[1]?.[0]).toEqual({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nresolved-ish\n=======\nincoming\n>>>>>>> origin/main'],
        },
      ],
      continueError: 'still conflicted after continue',
    });
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['push', '--force-with-lease'],
    ]);
  });

  it('returns the push-retry agent exit code without retrying push again', async () => {
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed' });
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

    expect(runAgent.mock.calls).toEqual([
      [],
      [undefined, 'git push -u origin HEAD exited with code 1:\npre-push hook failed'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  it('throws the final captured push failure after exhausting push retries', async () => {
    queueSpawnExit();
    queueExecResult();
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 1' });
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 2' });
    queueExecResult({ code: 1, stderr: 'pre-push hook failed', stdout: 'attempt 3' });
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

    expect(runAgent.mock.calls).toEqual([
      [],
      [undefined, 'git push -u origin HEAD exited with code 1:\npre-push hook failed\nattempt 1'],
      [undefined, 'git push -u origin HEAD exited with code 1:\npre-push hook failed\nattempt 2'],
      [undefined, 'git push -u origin HEAD exited with code 1:\npre-push hook failed\nattempt 3'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['push', '-u', 'origin', 'HEAD'],
      ['push', '-u', 'origin', 'HEAD'],
      ['push', '-u', 'origin', 'HEAD'],
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
    queueExecResult({ code: 1, stderr: 'continue failed once' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    queueExecResult({ code: 1, stderr: 'continue failed twice' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
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
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
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
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValueOnce(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    // rebase --continue fails (agent already committed)
    queueExecResult({ code: 1, stderr: 'No changes - did you forget to use git add?' });
    // listConflictedFiles returns empty
    queueExecResult({ stdout: '' });
    // git rev-parse --git-dir for isRebaseComplete
    queueExecResult({ stdout: '.git\n' });
    // accessMock rejects by default (ENOENT) → no rebase dirs → rebase complete
    // push (via execAsync, not spawnAsync)
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
    expect(gitArgsFromSpawnCalls()).toEqual([['fetch', 'origin']]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', '--autostash', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rev-parse', '--git-dir'],
      ['push', '--force-with-lease'],
    ]);
  });

  it('preserves the transport failure when rebase abort also fails', async () => {
    queueSpawnExit();
    queueExecResult({ code: 1, stderr: 'merge conflict' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    readFileMock.mockResolvedValue(
      ['<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> origin/main'].join('\n')
    );
    queueExecResult({ code: 1, stderr: 'continue failed once' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
    queueExecResult({ code: 1, stderr: 'continue failed twice' });
    queueExecResult({ stdout: 'src/conflict.ts\n' });
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
