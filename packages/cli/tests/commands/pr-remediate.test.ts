import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    withStageHooks: vi.fn(
      async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
    ),
    withIssueLock: vi.fn(async (_issue: unknown, fn: () => Promise<unknown>) => await fn()),
    withWorktree: vi.fn(
      async (_opts: unknown, fn: (wtPath: string) => Promise<unknown>) => await fn('/tmp/fake-wt')
    ),
    getBranchForPR: vi.fn(async () => 'shipper/10-feature'),
    getRepoRoot: vi.fn(async () => '/tmp/fake-repo'),
    gh: vi.fn(),
    sleepMs: vi.fn(async () => {}),
    getSettings: () => getSettingsMock(),
    fetchChecks: (...args: unknown[]) => fetchChecksMock(...args),
  };
});

import { gh, resolveRef, runPrompt } from '@dnsquared/shipper-core';

const mockGh = vi.mocked(gh);
const mockResolveRef = vi.mocked(resolveRef);
const mockRunPrompt = vi.mocked(runPrompt);

describe('prRemediateCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockResolveRef.mockResolvedValue({ prNumber: '42', issueNumber: '10' });
    mockRunPrompt.mockResolvedValue(0);
    mockGh.mockResolvedValue({
      stdout: JSON.stringify({ createdAt: new Date().toISOString() }),
      stderr: '',
    });
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'timer', timeoutMinutes: 0 },
      hooks: {},
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
  });

  it('passes issueNumber (not PR number) as issueRef to runPrompt', async () => {
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand('42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);

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

    await expect(prRemediateCommand('42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(mockRunPrompt).toHaveBeenCalled();
    expect(fetchChecksMock).not.toHaveBeenCalled();
  });

  it('in checks mode, polls and proceeds when all checks complete', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 1 },
      hooks: {},
    });
    fetchChecksMock.mockResolvedValue([
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'test', state: 'COMPLETED', bucket: 'pass' },
    ]);

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand('42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(mockRunPrompt).toHaveBeenCalled();
    expect(fetchChecksMock).toHaveBeenCalled();
  });

  it('in checks mode with zero checks, retries then proceeds', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 1 },
      hooks: {},
    });
    // Return empty array for all calls (initial + 3 grace retries)
    fetchChecksMock.mockResolvedValue([]);

    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand('42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(mockRunPrompt).toHaveBeenCalled();
    // Initial call + 3 grace retries = 4 calls
    expect(fetchChecksMock).toHaveBeenCalledTimes(4);
    expect(logMock).toHaveBeenCalledWith('No CI checks found. Proceeding.');
    logMock.mockRestore();
  });
});
