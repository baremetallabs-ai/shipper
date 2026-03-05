import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecFileSync = vi.fn();
const mockGetRepoNwo = vi.fn(() => 'owner/repo');
const mockGetSettings = vi.fn(() => ({
  lockTimeoutMinutes: 30,
  prReviewWaitMinutes: 15,
  hooks: {},
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../../src/lib/repo.js', () => ({
  getRepoNwo: () => mockGetRepoNwo(),
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => mockGetSettings(),
}));

const mockExit = vi.spyOn(process, 'exit');
const mockStderr = vi.spyOn(console, 'error');

import {
  isLockStale,
  acquireIssueLock,
  releaseIssueLock,
  withIssueLock,
} from '../../src/lib/lock.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockExit.mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  mockStderr.mockImplementation(() => {});
  delete process.env.SHIPPER_LOCK_HELD;
});

afterEach(() => {
  delete process.env.SHIPPER_LOCK_HELD;
});

describe('isLockStale', () => {
  it('returns false when lock was added recently', () => {
    const recentTime = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
    mockExecFileSync.mockReturnValue(recentTime);
    expect(isLockStale('42')).toBe(false);
  });

  it('returns true when lock was added longer ago than timeout', () => {
    const oldTime = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 min ago
    mockExecFileSync.mockReturnValue(oldTime);
    expect(isLockStale('42')).toBe(true);
  });

  it('returns true when no matching events found (empty output)', () => {
    mockExecFileSync.mockReturnValue('');
    expect(isLockStale('42')).toBe(true);
  });

  it('returns false when timeline fetch fails (fail closed)', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('API error');
    });
    expect(isLockStale('42')).toBe(false);
  });

  it('returns false when timestamp is malformed (fail closed)', () => {
    mockExecFileSync.mockReturnValue('not-a-date');
    expect(isLockStale('42')).toBe(false);
  });

  it('uses custom lockTimeoutMinutes from settings', () => {
    mockGetSettings.mockReturnValue({ lockTimeoutMinutes: 5, prReviewWaitMinutes: 15, hooks: {} });
    const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    mockExecFileSync.mockReturnValue(sixMinAgo);
    expect(isLockStale('42')).toBe(true);
  });

  it('uses last timestamp when multiple are returned', () => {
    const oldTime = new Date(Date.now() - 60 * 60_000).toISOString();
    const recentTime = new Date(Date.now() - 5 * 60_000).toISOString();
    mockExecFileSync.mockReturnValue(`${oldTime}\n${recentTime}`);
    expect(isLockStale('42')).toBe(false);
  });
});

describe('acquireIssueLock', () => {
  it('adds shipper:locked label when issue is not locked', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') return 'shipper:groomed\n';
      return '';
    });
    acquireIssueLock('42');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '42', '--add-label', 'shipper:locked'],
      expect.any(Object)
    );
  });

  it('exits with error when lock is held and not stale', () => {
    const recentTime = new Date(Date.now() - 5 * 60_000).toISOString();
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') return 'shipper:groomed\nshipper:locked\n';
      if (args[0] === 'api') return recentTime;
      return '';
    });
    try {
      acquireIssueLock('42');
    } catch {
      // process.exit mock may throw
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(
      expect.stringContaining('locked by another shipper instance')
    );
  });

  it('clears stale lock and re-acquires', () => {
    const oldTime = new Date(Date.now() - 60 * 60_000).toISOString();
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') return 'shipper:groomed\nshipper:locked\n';
      if (args[0] === 'api') return oldTime;
      return '';
    });
    acquireIssueLock('42');
    // Should have removed then added the label
    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls.length).toBeGreaterThanOrEqual(2);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining('stale'));
  });
});

describe('releaseIssueLock', () => {
  it('removes shipper:locked label', () => {
    mockExecFileSync.mockReturnValue('');
    releaseIssueLock('42');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '42', '--remove-label', 'shipper:locked'],
      expect.any(Object)
    );
  });

  it('ignores errors silently', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('label not found');
    });
    expect(() => releaseIssueLock('42')).not.toThrow();
  });
});

describe('withIssueLock', () => {
  it('passes through when SHIPPER_LOCK_HELD matches issue number', () => {
    process.env.SHIPPER_LOCK_HELD = '42';
    const fn = vi.fn(() => 'result');
    const result = withIssueLock('42', fn);
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalled();
    // Should not have called execFileSync for lock operations
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('acquires lock, runs fn, and releases lock', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') return 'shipper:groomed\n';
      return '';
    });
    const fn = vi.fn(() => 'result');
    const result = withIssueLock('42', fn);
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalled();
    // Verify lock was acquired and released
    const addCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[]).includes('--add-label') &&
        (call[1] as string[]).includes('shipper:locked')
    );
    const removeCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[]).includes('--remove-label') &&
        (call[1] as string[]).includes('shipper:locked')
    );
    expect(addCalls.length).toBe(1);
    expect(removeCalls.length).toBe(1);
  });

  it('releases lock even when fn throws', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') return 'shipper:groomed\n';
      return '';
    });
    expect(() =>
      withIssueLock('42', () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    const removeCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[]).includes('--remove-label') &&
        (call[1] as string[]).includes('shipper:locked')
    );
    expect(removeCalls.length).toBe(1);
  });

  it('sets and clears SHIPPER_LOCK_HELD env var', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') return 'shipper:groomed\n';
      return '';
    });
    let envDuringFn: string | undefined;
    withIssueLock('42', () => {
      envDuringFn = process.env.SHIPPER_LOCK_HELD;
      return 0;
    });
    expect(envDuringFn).toBe('42');
    expect(process.env.SHIPPER_LOCK_HELD).toBeUndefined();
  });
});
