import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toError } from '../../src/lib/errors.js';

const execFileMock = vi.fn();

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
              reject(toError(err));
              return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        );
      }),
  }
);
const mockGetSettings = vi.fn(() => ({
  lockTimeoutMinutes: 30,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile };
});

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}));

const stderrMock = vi.spyOn(console, 'error').mockImplementation(() => {});
const repo = 'owner/repo';

function queueExecFileResult(stdout: string): void {
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
    cb(null, stdout, '');
  });
}

function queueExecFileError(error: Error, stderr = 'HTTP 404 not found'): void {
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
    cb(Object.assign(error, { stderr }));
  });
}

function queueExecFileDeferred(): {
  resolve: (stdout?: string) => void;
  reject: (error: Error, stderr?: string) => void;
} {
  let cb: ((...cbArgs: unknown[]) => void) | undefined;
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
    cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
  });

  const getCallback = () => {
    if (!cb) {
      throw new Error('Deferred execFile callback was not registered');
    }
    return cb;
  };

  return {
    resolve: (stdout = '') => {
      getCallback()(null, stdout, '');
    },
    reject: (error, stderr = 'HTTP 404 not found') => {
      getCallback()(Object.assign(error, { stderr }));
    },
  };
}

function stderrMessages(): string[] {
  return stderrMock.mock.calls.map(([message]) => String(message));
}

const {
  isLockStale,
  acquireIssueLock,
  releaseIssueLock,
  withBufferedLockRenewalOutput,
  withIssueLock,
} = await import('../../src/lib/lock.js');

beforeEach(() => {
  execFileMock.mockReset();
  mockGetSettings.mockClear();
  stderrMock.mockClear();
});

describe('isLockStale', () => {
  it('returns false for a recent lock', async () => {
    queueExecFileResult(new Date(Date.now() - 5 * 60_000).toISOString());

    await expect(isLockStale(repo, '42')).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['api', `repos/${repo}/issues/42/timeline`, '--paginate', '--jq', expect.any(String)],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });

  it('returns true for an old lock', async () => {
    queueExecFileResult(new Date(Date.now() - 60 * 60_000).toISOString());

    await expect(isLockStale(repo, '42')).resolves.toBe(true);
  });
});

describe('acquireIssueLock', () => {
  it('adds shipper:locked when the issue is unlocked', async () => {
    queueExecFileResult('shipper:groomed\n');
    queueExecFileResult('');

    await acquireIssueLock(repo, '42');

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'edit', '42', '-R', repo, '--add-label', 'shipper:locked'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });

  it('clears a stale lock before re-acquiring', async () => {
    queueExecFileResult('shipper:groomed\nshipper:locked\n');
    queueExecFileResult(new Date(Date.now() - 60 * 60_000).toISOString());
    queueExecFileResult('');
    queueExecFileResult('');

    await acquireIssueLock(repo, '42');

    expect(stderrMock).toHaveBeenCalledWith('[shipper] Issue #42 lock is stale — clearing.');
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '42', '-R', repo, '--remove-label', 'shipper:locked'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '42', '-R', repo, '--add-label', 'shipper:locked'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });

  it('throws when the lock is active and not stale', async () => {
    queueExecFileResult('shipper:groomed\nshipper:locked\n');
    queueExecFileResult(new Date(Date.now() - 5 * 60_000).toISOString());

    await expect(acquireIssueLock(repo, '42')).rejects.toThrow(
      'Issue #42 is locked by another shipper instance.'
    );
  });
});

describe('releaseIssueLock', () => {
  it('removes shipper:locked and ignores errors', async () => {
    queueExecFileResult('');
    await expect(releaseIssueLock(repo, '42')).resolves.toBeUndefined();

    queueExecFileError(new Error('label missing'));
    await expect(releaseIssueLock(repo, '42')).resolves.toBeUndefined();
  });
});

describe('withBufferedLockRenewalOutput', () => {
  it('returns the callback result without logging when no issue lock is active', async () => {
    await expect(withBufferedLockRenewalOutput(() => Promise.resolve('ok'))).resolves.toBe('ok');

    expect(stderrMock).not.toHaveBeenCalled();
  });
});

describe('withIssueLock', () => {
  it('passes through nested calls for the same issue', async () => {
    queueExecFileResult('shipper:groomed\n');
    queueExecFileResult('');
    queueExecFileResult('');

    const fn = vi.fn(() => Promise.resolve('result'));

    await expect(
      withIssueLock(repo, '42', async () => await withIssueLock(repo, '42', fn))
    ).resolves.toBe('result');
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it('acquires and releases around an async callback', async () => {
    queueExecFileResult('shipper:groomed\n');
    queueExecFileResult('');
    queueExecFileResult('');

    const result = await withIssueLock(repo, '42', async () => {
      await expect(withIssueLock(repo, '42', () => Promise.resolve('ok'))).resolves.toBe('ok');
      return 'ok';
    });

    expect(result).toBe('ok');
  });

  it('does not passthrough a nested lock for a different repo with the same issue number', async () => {
    queueExecFileResult('shipper:groomed\n');
    queueExecFileResult('');
    queueExecFileResult('shipper:groomed\n');
    queueExecFileResult('');
    queueExecFileResult('');
    queueExecFileResult('');

    await expect(
      withIssueLock(repo, '42', async () => await withIssueLock('other/repo', '42', () => 'ok'))
    ).resolves.toBe('ok');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '42', '-R', 'other/repo', '--add-label', 'shipper:locked'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });

  it('releases the lock when the callback rejects', async () => {
    queueExecFileResult('shipper:groomed\n');
    queueExecFileResult('');
    queueExecFileResult('');

    await expect(
      withIssueLock(repo, '42', () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(execFileMock).toHaveBeenLastCalledWith(
      'gh',
      ['issue', 'edit', '42', '-R', repo, '--remove-label', 'shipper:locked'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });

  it('renews the lock inline by default on heartbeat interval', async () => {
    vi.useFakeTimers();
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');

      // renewal: remove-label + add-label
      queueExecFileResult('');
      queueExecFileResult('');

      // release: remove-label
      queueExecFileResult('');

      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });

      const resultPromise = withIssueLock(repo, '42', () => blocker);

      // Advance past one heartbeat interval (10 min = 600_000 ms)
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      // Verify renewal gh calls were made (calls 3 and 4)
      expect(execFileMock).toHaveBeenCalledWith(
        'gh',
        ['issue', 'edit', '42', '-R', repo, '--remove-label', 'shipper:locked'],
        expect.objectContaining({ encoding: 'utf-8' }),
        expect.any(Function)
      );
      expect(execFileMock).toHaveBeenCalledWith(
        'gh',
        ['issue', 'edit', '42', '-R', repo, '--add-label', 'shipper:locked'],
        expect.objectContaining({ encoding: 'utf-8' }),
        expect.any(Function)
      );
      expect(stderrMock).toHaveBeenCalledWith('[shipper] Lock renewed for issue #42');

      resolve();
      await resultPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs warning inline by default and continues when renewal fails', async () => {
    vi.useFakeTimers();
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');

      // renewal remove-label fails
      queueExecFileError(new Error('API unavailable'));

      // release: remove-label
      queueExecFileResult('');

      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });

      const resultPromise = withIssueLock(repo, '42', () => blocker);

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(stderrMock).toHaveBeenCalledWith(
        expect.stringContaining('[shipper] Warning: lock renewal failed for issue #42')
      );

      resolve();
      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears heartbeat timer on normal completion', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');
      // release: remove-label
      queueExecFileResult('');

      await withIssueLock(repo, '42', () => Promise.resolve('done'));

      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });

  it('clears heartbeat timer on callback rejection', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');
      // release: remove-label
      queueExecFileResult('');

      await expect(
        withIssueLock(repo, '42', () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });

  it('logs distinct warning inline by default when remove succeeds but add fails', async () => {
    vi.useFakeTimers();
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');

      // renewal: remove-label succeeds, add-label fails
      queueExecFileResult('');
      queueExecFileError(new Error('API unavailable'));

      // release: remove-label
      queueExecFileResult('');

      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });

      const resultPromise = withIssueLock(repo, '42', () => blocker);

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(stderrMock).toHaveBeenCalledWith(
        expect.stringContaining('[shipper] Warning: lock re-add failed for issue #42')
      );

      resolve();
      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses successful renewal output while buffered', async () => {
    vi.useFakeTimers();
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');

      // renewal: remove-label + add-label
      queueExecFileResult('');
      queueExecFileResult('');

      // release: remove-label
      queueExecFileResult('');

      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });

      const resultPromise = withIssueLock(repo, '42', async () => {
        await withBufferedLockRenewalOutput(() => blocker);
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(
        stderrMessages().some((message) => message.includes('Lock renewed for issue #42'))
      ).toBe(false);

      resolve();
      await resultPromise;

      expect(
        stderrMessages().some((message) => message.includes('Lock renewed for issue #42'))
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers remove-label renewal failures and emits one deferred warning', async () => {
    vi.useFakeTimers();
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');

      // renewal remove-label fails
      queueExecFileError(new Error('API unavailable'), 'HTTP 404 remove failed');

      // release: remove-label
      queueExecFileResult('');

      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });

      const resultPromise = withIssueLock(repo, '42', async () => {
        await withBufferedLockRenewalOutput(() => blocker);
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(
        stderrMessages().filter((message) => message.includes('lock renewal failed'))
      ).toHaveLength(0);

      resolve();
      await expect(resultPromise).resolves.toBeUndefined();

      const renewalMessages = stderrMessages().filter((message) =>
        message.includes('lock renewal')
      );
      expect(renewalMessages).toHaveLength(1);
      expect(renewalMessages[0]).toContain('1 lock renewal failure');
      expect(renewalMessages[0]).toContain('lock renewal failed for issue #42');
      expect(renewalMessages[0]).toContain('HTTP 404 remove failed');
      expect(renewalMessages[0]).not.toContain('latest failure: Warning:');
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers re-add renewal failures and emits one deferred warning', async () => {
    vi.useFakeTimers();
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');

      // renewal: remove-label succeeds, add-label fails
      queueExecFileResult('');
      queueExecFileError(new Error('API unavailable'), 'HTTP 404 add failed');

      // release: remove-label
      queueExecFileResult('');

      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });

      const resultPromise = withIssueLock(repo, '42', async () => {
        await withBufferedLockRenewalOutput(() => blocker);
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(
        stderrMessages().filter((message) => message.includes('lock re-add failed'))
      ).toHaveLength(0);

      resolve();
      await expect(resultPromise).resolves.toBeUndefined();

      const renewalMessages = stderrMessages().filter((message) =>
        message.includes('lock renewal')
      );
      expect(renewalMessages).toHaveLength(1);
      expect(renewalMessages[0]).toContain('1 lock renewal failure');
      expect(renewalMessages[0]).toContain('lock re-add failed for issue #42');
      expect(renewalMessages[0]).toContain('HTTP 404 add failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('summarizes multiple buffered failures with the latest failure message', async () => {
    vi.useFakeTimers();
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');

      // two renewal remove-label failures
      queueExecFileError(new Error('API unavailable'), 'HTTP 404 first remove failed');
      queueExecFileError(new Error('API unavailable'), 'HTTP 404 second remove failed');

      // release: remove-label
      queueExecFileResult('');

      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });

      const resultPromise = withIssueLock(repo, '42', async () => {
        await withBufferedLockRenewalOutput(() => blocker);
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(
        stderrMessages().filter((message) => message.includes('lock renewal failed'))
      ).toHaveLength(0);

      resolve();
      await expect(resultPromise).resolves.toBeUndefined();

      const renewalMessages = stderrMessages().filter((message) =>
        message.includes('lock renewal')
      );
      expect(renewalMessages).toHaveLength(1);
      expect(renewalMessages[0]).toContain('2 lock renewal failures');
      expect(renewalMessages[0]).toContain('HTTP 404 second remove failed');
      expect(renewalMessages[0]).not.toContain('HTTP 404 first remove failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains buffered renewals that finish after the buffered scope exits', async () => {
    vi.useFakeTimers();
    try {
      // acquire: labels check + add-label
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');

      // renewal: remove-label succeeds, add-label completes after the stage body exits
      queueExecFileResult('');
      const delayedAdd = queueExecFileDeferred();

      // release: remove-label
      queueExecFileResult('');

      let resolveStage!: () => void;
      const stageBody = new Promise<void>((resolve) => {
        resolveStage = resolve;
      });

      const resultPromise = withIssueLock(repo, '42', async () => {
        await withBufferedLockRenewalOutput(() => stageBody);
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(
        stderrMessages().filter((message) => message.includes('lock re-add failed'))
      ).toHaveLength(0);

      let settled = false;
      void resultPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      resolveStage();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      delayedAdd.reject(new Error('API unavailable'), 'HTTP 404 delayed add failed');

      await expect(resultPromise).resolves.toBeUndefined();

      const renewalMessages = stderrMessages().filter((message) =>
        message.includes('lock renewal')
      );
      expect(renewalMessages).toHaveLength(1);
      expect(renewalMessages[0]).toContain('1 lock renewal failure');
      expect(renewalMessages[0]).toContain('lock re-add failed for issue #42');
      expect(renewalMessages[0]).toContain('HTTP 404 delayed add failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start an additional heartbeat for nested calls', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      queueExecFileResult('shipper:groomed\n');
      queueExecFileResult('');
      queueExecFileResult('');

      await withIssueLock(repo, '42', async () => {
        await withIssueLock(repo, '42', () => Promise.resolve('result'));
      });

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
