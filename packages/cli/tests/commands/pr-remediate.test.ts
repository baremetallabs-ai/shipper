import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

const getSettingsMock = vi.fn();
const fetchChecksMock = vi.fn();
vi.mock('@dnsquared/shipper-core', async () => {
  const actual =
    await vi.importActual<typeof import('@dnsquared/shipper-core')>('@dnsquared/shipper-core');
  return {
    ...actual,
    resolveRef: vi.fn(),
    autoSelectPrForStage: vi.fn(),
    runPrompt: vi.fn(),
    withStageHooks: vi.fn((_stage: unknown, _env: unknown, fn: () => unknown) => fn()),
    withIssueLock: vi.fn((_issue: unknown, fn: () => unknown) => fn()),
    withWorktree: vi.fn((_opts: unknown, fn: (wtPath: string) => unknown) => fn('/tmp/fake-wt')),
    getBranchForPR: vi.fn(() => 'shipper/10-feature'),
    getRepoRoot: vi.fn(() => '/tmp/fake-repo'),
    sleepMs: vi.fn(),
    getSettings: () => getSettingsMock(),
    fetchChecks: (...args: unknown[]) => fetchChecksMock(...args),
  };
});

import { resolveRef, runPrompt } from '@dnsquared/shipper-core';

const mockResolveRef = vi.mocked(resolveRef);
const mockRunPrompt = vi.mocked(runPrompt);

describe('prRemediateCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRef.mockReturnValue({ prNumber: '42', issueNumber: '10' });
    mockRunPrompt.mockReturnValue(0);
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'timer', timeoutMinutes: 0 },
      hooks: {},
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('passes issueNumber (not PR number) as issueRef to runPrompt', async () => {
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    expect(() => prRemediateCommand('42')).toThrow('exit:0');

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'pr_remediate',
      expect.objectContaining({
        issueRef: '10',
        prRef: '42',
      })
    );
  });

  it('in timer mode with timeoutMinutes 0, skips wait and runs prompt', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'timer', timeoutMinutes: 0 },
      hooks: {},
    });
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    expect(() => prRemediateCommand('42')).toThrow('exit:0');
    expect(mockRunPrompt).toHaveBeenCalled();
    expect(fetchChecksMock).not.toHaveBeenCalled();
  });

  it('in checks mode, polls and proceeds when all checks complete', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 1 },
      hooks: {},
    });
    fetchChecksMock.mockReturnValue([
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'test', state: 'COMPLETED', bucket: 'pass' },
    ]);

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    expect(() => prRemediateCommand('42')).toThrow('exit:0');
    expect(mockRunPrompt).toHaveBeenCalled();
    expect(fetchChecksMock).toHaveBeenCalled();
  });

  it('in checks mode with zero checks, retries then proceeds', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 1 },
      hooks: {},
    });
    // Return empty array for all calls (initial + 3 grace retries)
    fetchChecksMock.mockReturnValue([]);

    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    expect(() => prRemediateCommand('42')).toThrow('exit:0');
    expect(mockRunPrompt).toHaveBeenCalled();
    // Initial call + 3 grace retries = 4 calls
    expect(fetchChecksMock).toHaveBeenCalledTimes(4);
    expect(logMock).toHaveBeenCalledWith('No CI checks found. Proceeding.');
    logMock.mockRestore();
  });
});
