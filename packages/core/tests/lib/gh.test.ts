import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { toError, toErrorMessage } from '../../src/lib/errors.js';

const execFileMock = vi.fn();
const sleepMsMock = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

const execFile = Object.assign(
  (...args: unknown[]) => {
    execFileMock(...args);
  },
  {
    [promisify.custom]: (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFileMock(
          ...args,
          (err: unknown, stdout: string | Buffer = '', stderr: string | Buffer = '') => {
            if (err) {
              const error = toError(err) as Error & { stdout?: string; stderr?: string };
              error.stdout ??= String(stdout);
              error.stderr ??= String(stderr);
              reject(error);
              return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        );
      }),
  }
);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile };
});

vi.mock('../../src/lib/sleep.js', () => ({
  sleepMs: (ms: number) => sleepMsMock(ms),
}));

const { GhError, getGhErrorDetail, gh, isGhError, isRecoverableReviewSubmissionGhError } =
  await import('../../src/lib/gh.js');

function transientError(message: string, stderr = message): Error & { stderr: string } {
  return Object.assign(new Error(message), { stderr });
}

function permanentError(message: string): Error & { stderr: string } {
  return Object.assign(new Error(message), { stderr: message });
}

function missingBinaryError(): Error & { code: string } {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
}

function makeGhError(detail: { stdout?: string; stderr?: string; code?: string | number }) {
  return new GhError(
    ['api', 'repos/owner/repo/pulls/42/reviews'],
    Object.assign(new Error(detail.stderr ?? detail.stdout ?? 'gh failed'), {
      stdout: detail.stdout ?? '',
      stderr: detail.stderr ?? '',
      ...(detail.code === undefined ? {} : { code: detail.code }),
    })
  );
}

describe('gh', () => {
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    execFileMock.mockReset();
    sleepMsMock.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns stdout and stderr on the first successful attempt', async () => {
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(null, 'ok\n', '');
    });

    await expect(gh(['repo', 'view'])).resolves.toEqual({ stdout: 'ok\n', stderr: '' });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('retries transient failures with exponential backoff and then succeeds', async () => {
    execFileMock
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(transientError('HTTP 500'));
      })
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(transientError('temporary network failure'));
      })
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(null, 'done\n', '');
      });

    const promise = gh(['issue', 'view', '42']);

    await Promise.resolve();
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      '[shipper] gh issue view 42 failed: HTTP 500, retrying (attempt 2/3)...'
    );
    expect(sleepMsMock).toHaveBeenNthCalledWith(1, 1000);

    await expect(promise).resolves.toEqual({ stdout: 'done\n', stderr: '' });
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      '[shipper] gh issue view 42 failed: temporary network failure, retrying (attempt 3/3)...'
    );
    expect(sleepMsMock).toHaveBeenNthCalledWith(2, 2000);
  });

  it('throws a GhError for the last error after exhausting all retry attempts', async () => {
    const first = transientError('HTTP 500 first');
    const second = transientError('HTTP 500 second');
    const third = transientError('HTTP 500 third');

    execFileMock
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(first);
      })
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(second);
      })
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(third);
      });

    const promise = gh(['pr', 'view', '42']);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await expect(promise).rejects.toBeInstanceOf(GhError);
    await expect(promise).rejects.toMatchObject({
      args: ['pr', 'view', '42'],
      command: 'gh pr view 42',
      stderr: 'HTTP 500 third',
      stdout: '',
    });
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      '[shipper] gh pr view 42 failed: HTTP 500 first, retrying (attempt 2/3)...'
    );
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      '[shipper] gh pr view 42 failed: HTTP 500 second, retrying (attempt 3/3)...'
    );
    try {
      await promise;
    } catch (error) {
      expect(toErrorMessage(error)).toContain('gh pr view 42 failed: HTTP 500 third');
      expect(toErrorMessage(error)).not.toContain('HTTP 500 first');
    }
    expect(sleepMsMock).toHaveBeenNthCalledWith(1, 1000);
    expect(sleepMsMock).toHaveBeenNthCalledWith(2, 2000);
  });

  it('omits the reason segment when stderr is empty on a retry', async () => {
    execFileMock
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(transientError('temporary network failure', '   '));
      })
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(null, 'ok\n', '');
      });

    const promise = gh(['repo', 'list']);

    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] gh repo list failed, retrying (attempt 2/3)...'
    );

    await expect(promise).resolves.toEqual({ stdout: 'ok\n', stderr: '' });
  });

  it('quotes args with spaces and escapes multiline stderr in retry logs', async () => {
    execFileMock
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(transientError('temporary network failure', 'line 1\nline 2'));
      })
      .mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
        cb(null, 'ok\n', '');
      });

    const promise = gh([
      'issue',
      'list',
      '--search',
      '-label:shipper:blocked -label:shipper:locked',
      '--jq',
      '.[] | .title',
    ]);

    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] gh issue list --search "-label:shipper:blocked -label:shipper:locked" --jq ".[] | .title" failed: line 1\\nline 2, retrying (attempt 2/3)...'
    );

    await expect(promise).resolves.toEqual({ stdout: 'ok\n', stderr: '' });
  });

  it.each([
    'HTTP 401 unauthorized',
    'HTTP 404 missing',
    'HTTP 422 validation failed',
    'could not resolve to a Repository',
    'validation failed',
    'No commit found on the pull request',
    'merge already in progress',
    'Already in progress',
    'must be run in a work tree',
  ])('does not retry permanent failure "%s"', async (stderr) => {
    const err = permanentError(stderr);
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(err);
    });

    const promise = gh(['issue', 'view', '42']);

    await expect(promise).rejects.toBeInstanceOf(GhError);
    await expect(promise).rejects.toMatchObject({
      args: ['issue', 'view', '42'],
      command: 'gh issue view 42',
      stderr,
      stdout: '',
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(sleepMsMock).not.toHaveBeenCalled();
  });

  it('does not retry when gh is missing from PATH', async () => {
    const err = missingBinaryError();
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(err);
    });

    const promise = gh(['--version']);

    await expect(promise).rejects.toBeInstanceOf(GhError);
    await expect(promise).rejects.toMatchObject({
      args: ['--version'],
      command: 'gh --version',
      code: 'ENOENT',
      stderr: '',
      stdout: '',
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(sleepMsMock).not.toHaveBeenCalled();
  });

  it('preserves command, stderr status, and stdout diagnostic body for terminal gh api failures', async () => {
    const stderr = 'gh: Validation Failed (HTTP 422)';
    const stdout =
      '{"message":"Validation Failed","errors":[{"message":"line must be part of the diff"}]}';

    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(new Error('exit status 1'), stdout, stderr);
    });

    let thrown: unknown;
    try {
      await gh(['api', 'repos/owner/repo/pulls/42/reviews']);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GhError);
    expect(isGhError(thrown)).toBe(true);
    expect(toErrorMessage(thrown)).toContain('gh api repos/owner/repo/pulls/42/reviews failed');
    expect(toErrorMessage(thrown)).toContain(stderr);
    expect(toErrorMessage(thrown)).toContain(stdout);
    expect(getGhErrorDetail(thrown)).toContain('stdout:');
    expect(getGhErrorDetail(thrown)).toContain(stdout);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(sleepMsMock).not.toHaveBeenCalled();
  });

  it('recognizes structural GhError objects from fake transports', () => {
    const fake = Object.assign(new Error('gh api failed'), {
      name: 'GhError',
      args: ['api', 'repos/owner/repo/pulls/42/reviews'],
      command: 'gh api repos/owner/repo/pulls/42/reviews',
      stdout: '{"message":"Validation Failed"}',
      stderr: 'gh: Validation Failed (HTTP 422)',
    });

    expect(isGhError(fake)).toBe(true);
    expect(isRecoverableReviewSubmissionGhError(fake)).toBe(true);
  });

  it.each([
    [
      'HTTP 422',
      makeGhError({
        stderr: 'gh: Validation Failed (HTTP 422)',
        stdout: '{"message":"Validation Failed"}',
      }),
      true,
    ],
    ['validation failed', makeGhError({ stderr: 'validation failed' }), true],
    ['HTTP 401', makeGhError({ stderr: 'gh: Bad credentials (HTTP 401)' }), false],
    ['HTTP 403', makeGhError({ stderr: 'gh: Forbidden (HTTP 403)' }), false],
    ['HTTP 404', makeGhError({ stderr: 'gh: Not Found (HTTP 404)' }), false],
    ['missing binary', makeGhError({ stderr: 'spawn gh ENOENT', code: 'ENOENT' }), false],
    ['network failure', makeGhError({ stderr: 'network connection timed out' }), false],
  ])('classifies recoverable review submission errors: %s', (_name, error, expected) => {
    expect(isRecoverableReviewSubmissionGhError(error)).toBe(expected);
  });
});
