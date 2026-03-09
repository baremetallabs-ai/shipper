import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
const sleepMsMock = vi.fn(async (_ms: number) => {});
const execFile = Object.assign((...args: unknown[]) => execFileMock(...args), {
  [promisify.custom]: (...args: unknown[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFileMock(
        ...args,
        (err: unknown, stdout: string | Buffer = '', stderr: string | Buffer = '') => {
          if (err) {
            reject(err);
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      );
    }),
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile };
});

vi.mock('../../src/lib/sleep.js', () => ({
  sleepMs: (ms: number) => sleepMsMock(ms),
}));

const { gh } = await import('../../src/lib/gh.js');

function transientError(message: string): Error & { stderr: string } {
  return Object.assign(new Error(message), { stderr: message });
}

function permanentError(message: string): Error & { stderr: string } {
  return Object.assign(new Error(message), { stderr: message });
}

function missingBinaryError(): Error & { code: string } {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
}

describe('gh', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

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
    expect(errorSpy).toHaveBeenNthCalledWith(1, 'gh call failed, retrying (attempt 2/3)...');
    expect(sleepMsMock).toHaveBeenNthCalledWith(1, 1000);

    await expect(promise).resolves.toEqual({ stdout: 'done\n', stderr: '' });
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenNthCalledWith(2, 'gh call failed, retrying (attempt 3/3)...');
    expect(sleepMsMock).toHaveBeenNthCalledWith(2, 2000);
  });

  it('throws the first error after exhausting all retry attempts', async () => {
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

    await expect(promise).rejects.toBe(first);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(sleepMsMock).toHaveBeenNthCalledWith(1, 1000);
    expect(sleepMsMock).toHaveBeenNthCalledWith(2, 2000);
  });

  it.each([
    'HTTP 401 unauthorized',
    'HTTP 404 missing',
    'HTTP 422 validation failed',
    'could not resolve to a Repository',
    'validation failed',
  ])('does not retry permanent failure "%s"', async (stderr) => {
    const err = permanentError(stderr);
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(err);
    });

    await expect(gh(['issue', 'view', '42'])).rejects.toBe(err);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not retry when gh is missing from PATH', async () => {
    const err = missingBinaryError();
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(err);
    });

    await expect(gh(['--version'])).rejects.toBe(err);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(sleepMsMock).not.toHaveBeenCalled();
  });
});
