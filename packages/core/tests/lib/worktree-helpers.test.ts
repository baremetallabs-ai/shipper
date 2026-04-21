import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock =
  vi.fn<
    (
      command: string,
      args: string[],
      execOpts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => object
  >();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileMock(...args),
  };
});

const { getCommitsAheadCount } = await import('../../src/lib/worktree.js');
const { execAsync, toError } = await import('../../src/lib/worktree/helpers.js');

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

function gitArgsFromExecCalls(): string[][] {
  return execFileMock.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args);
}

describe('getCommitsAheadCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the number of commits ahead of the base branch', async () => {
    queueExecResult({ stdout: '3\n' });

    await expect(getCommitsAheadCount('/tmp/wt', 'main')).resolves.toBe(3);

    expect(gitArgsFromExecCalls()).toEqual([['rev-list', '--count', 'origin/main..HEAD']]);
    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({
      cwd: '/tmp/wt',
    });
  });

  it('throws a formatted error when git rev-list fails', async () => {
    queueExecResult({ code: 128, stderr: 'fatal: bad revision' });

    await expect(getCommitsAheadCount('/tmp/wt', 'main')).rejects.toThrow(
      'git rev-list --count origin/main..HEAD exited with code 128:\nfatal: bad revision'
    );
    expect(gitArgsFromExecCalls()).toEqual([['rev-list', '--count', 'origin/main..HEAD']]);
  });

  it('throws when git rev-list returns a non-numeric count', async () => {
    queueExecResult({ stdout: '\n' });

    await expect(getCommitsAheadCount('/tmp/wt', 'main')).rejects.toThrow(
      'git rev-list --count origin/main..HEAD returned a non-numeric commit count'
    );
    expect(gitArgsFromExecCalls()).toEqual([['rev-list', '--count', 'origin/main..HEAD']]);
  });
});

describe('execAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('maps string-coded execFile errors to exit code 1 and falls back to the error message', async () => {
    execFileMock.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _execOpts: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        globalThis.queueMicrotask(() => {
          const error = new Error('stdout maxBuffer length exceeded') as Error & {
            code?: string;
            stdout?: string;
            stderr?: string;
          };
          error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          error.stdout = '';
          error.stderr = '';
          callback(error, '', '');
        });
        return {} as object;
      }
    );

    await expect(execAsync('npm ci', [], { cwd: '/tmp/wt' })).resolves.toEqual({
      code: 1,
      stdout: '',
      stderr: 'stdout maxBuffer length exceeded',
    });
  });
});

describe('toError', () => {
  it('does not throw for circular objects', () => {
    const input: { self?: unknown } = {};
    input.self = input;

    expect(() => toError(input)).not.toThrow();
    expect(toError(input).message).toBe('[object Object]');
  });
});
