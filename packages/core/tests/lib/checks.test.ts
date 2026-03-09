import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

import { fetchChecks, classifyChecks, type PRChecksLine } from '../../src/lib/checks.js';

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe('fetchChecks', () => {
  it('calls gh pr checks with --json and parses output', () => {
    const checks = [{ name: 'build', state: 'COMPLETED', bucket: 'pass' }];
    execFileSyncMock.mockReturnValue(JSON.stringify(checks));

    const result = fetchChecks('42');

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'checks', '42', '--json', 'name,state,bucket'],
      expect.objectContaining({ encoding: 'utf-8' })
    );
    expect(result).toEqual(checks);
  });

  it('includes -R flag when nwo is provided', () => {
    execFileSyncMock.mockReturnValue('[]');

    fetchChecks('42', 'owner/repo');

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'checks', '42', '--json', 'name,state,bucket', '-R', 'owner/repo'],
      expect.objectContaining({ encoding: 'utf-8' })
    );
  });

  it('does not include -R flag when nwo is omitted', () => {
    execFileSyncMock.mockReturnValue('[]');

    fetchChecks('42');

    const args = execFileSyncMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain('-R');
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
