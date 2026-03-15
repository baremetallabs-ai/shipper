import { promisify } from 'node:util';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

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
              reject(normalizeError(err));
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

const { fetchChecks, classifyChecks } = await import('../../src/lib/checks.js');
type PRChecksLine = import('../../src/lib/checks.js').PRChecksLine;
const repo = 'owner/repo';

beforeEach(() => {
  execFileMock.mockReset();
});

describe('fetchChecks', () => {
  it('calls gh pr checks with --json and parses output', async () => {
    const checks = [{ name: 'build', state: 'COMPLETED', bucket: 'pass' }];
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(null, JSON.stringify(checks), '');
    });

    const result = await fetchChecks(repo, '42');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'checks', '42', '-R', repo, '--json', 'name,state,bucket'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(result).toEqual(checks);
  });

  it('always includes -R with the repo argument', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
      cb(null, '[]', '');
    });

    await fetchChecks(repo, '42');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'checks', '42', '-R', repo, '--json', 'name,state,bucket'],
      expect.objectContaining({ encoding: 'utf-8' }),
      expect.any(Function)
    );
  });
});

describe('classifyChecks', () => {
  it('classifies all passing checks', () => {
    const checks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'lint', state: 'COMPLETED', bucket: 'pass' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(2);
    expect(result.pending).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.total).toBe(2);
  });

  it('classifies pending checks', () => {
    const checks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'test', state: 'PENDING', bucket: 'pending' },
      { name: 'lint', state: 'IN_PROGRESS', bucket: 'pending' },
      { name: 'deploy', state: 'QUEUED', bucket: 'pending' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(1);
    expect(result.pending).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.total).toBe(4);
  });

  it('classifies failed checks', () => {
    const checks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'fail' },
      { name: 'test', state: 'COMPLETED', bucket: 'fail' },
      { name: 'lint', state: 'COMPLETED', bucket: 'cancel' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
    expect(result.failed).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it('returns empty arrays for empty input', () => {
    const result = classifyChecks([]);

    expect(result).toEqual({ pending: [], failed: [], passed: [], total: 0 });
  });

  it('classifies skipped checks as passed', () => {
    const checks: PRChecksLine[] = [
      { name: 'optional', state: 'COMPLETED', bucket: 'skipping' },
      { name: 'neutral', state: 'COMPLETED', bucket: 'pass' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(2);
    expect(result.pending).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('handles mixed states correctly', () => {
    const checks: PRChecksLine[] = [
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'test', state: 'IN_PROGRESS', bucket: 'pending' },
      { name: 'lint', state: 'COMPLETED', bucket: 'fail' },
      { name: 'deploy', state: 'COMPLETED', bucket: 'skipping' },
    ];

    const result = classifyChecks(checks);

    expect(result.passed).toHaveLength(2);
    expect(result.pending).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.total).toBe(4);
  });
});
