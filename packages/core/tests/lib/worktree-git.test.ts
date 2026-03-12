import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const execFileMock = vi.fn();
const readFileMock = vi.fn();

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
  };
});

vi.mock('../../src/lib/hooks.js', () => ({
  runAdvisoryHook: vi.fn(),
  runWorktreeHook: vi.fn(),
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: vi.fn(() => ({ hooks: {} })),
}));

const { formatConflictContext, withGitTransport } = await import('../../src/lib/worktree.js');

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
  return spawnMock.mock.calls.map(([, args]) => args as string[]);
}

function gitArgsFromExecCalls(): string[][] {
  return execFileMock.mock.calls.map(([, args]) => args as string[]);
}

describe('withGitTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches, runs the agent, and pushes a new branch after a clean rebase', async () => {
    queueSpawnExit();
    queueExecResult();
    queueSpawnExit();
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
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([['rebase', 'origin/main']]);
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
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['fetch', 'origin'],
      ['push', '--force-with-lease'],
    ]);
    expect(gitArgsFromExecCalls()).toEqual([
      ['rebase', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
    ]);
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
      ['rebase', 'origin/main'],
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
      ['rebase', 'origin/main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rebase', '--continue'],
    ]);
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
        'Resolve all conflicts, then use `git add` to stage the resolved files and `git commit` if Git asks for it. Do not run `git rebase --continue`, `git rebase --abort`, or `git push` yourself.',
      ].join('\n')
    );
  });
});
