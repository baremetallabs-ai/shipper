import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
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
const mockGetSettings = vi.fn(() => ({
  lockTimeoutMinutes: 30,
  hooks: {},
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

function queueExecFileError(error: Error): void {
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
    cb(Object.assign(error, { stderr: 'HTTP 404 not found' }));
  });
}

const { isLockStale, acquireIssueLock, releaseIssueLock, withIssueLock } =
  await import('../../src/lib/lock.js');

beforeEach(() => {
  execFileMock.mockReset();
  mockGetSettings.mockClear();
  stderrMock.mockClear();
  delete process.env.SHIPPER_LOCK_HELD;
});

afterEach(() => {
  delete process.env.SHIPPER_LOCK_HELD;
});

describe('isLockStale', () => {
  it('returns false for a recent lock', async () => {
    queueExecFileResult(new Date(Date.now() - 5 * 60_000).toISOString());

    await expect(isLockStale(repo, '42')).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        '-R',
        repo,
        `repos/${repo}/issues/42/timeline`,
        '--paginate',
        '--jq',
        expect.any(String),
      ],
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

    expect(stderrMock).toHaveBeenCalledWith('Issue #42 lock is stale — clearing.');
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

describe('withIssueLock', () => {
  it('passes through when SHIPPER_LOCK_HELD already matches', async () => {
    process.env.SHIPPER_LOCK_HELD = '42';
    const fn = vi.fn(async () => 'result');

    await expect(withIssueLock(repo, '42', fn)).resolves.toBe('result');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('acquires and releases around an async callback', async () => {
    queueExecFileResult('shipper:groomed\n');
    queueExecFileResult('');
    queueExecFileResult('');

    let envDuringFn: string | undefined;
    const result = await withIssueLock(repo, '42', async () => {
      envDuringFn = process.env.SHIPPER_LOCK_HELD;
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(envDuringFn).toBe('42');
    expect(process.env.SHIPPER_LOCK_HELD).toBeUndefined();
  });

  it('releases the lock when the callback rejects', async () => {
    queueExecFileResult('shipper:groomed\n');
    queueExecFileResult('');
    queueExecFileResult('');

    await expect(
      withIssueLock(repo, '42', async () => {
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
});
