import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRunResult, StageScaffoldOpts } from '@dnsquared/shipper-core';

const autoSelectIssueMock = vi.fn();
const generateBranchNameMock = vi.fn(() => Promise.resolve('shipper/239-branch'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('main'));
const runStageScaffoldMock = vi.fn<(opts: StageScaffoldOpts) => Promise<StageRunResult>>(() =>
  Promise.resolve({ success: true, exitCode: 0, verdict: 'accept' })
);
const transportInvokerFactoryMock = vi.fn();
const transportInvokerMock = vi.fn(() => transportInvokerFactoryMock);
const loggerErrorMock = vi.fn<(message: string) => void>();

vi.mock('@dnsquared/shipper-core', () => ({
  autoSelectIssue: autoSelectIssueMock,
  generateBranchName: generateBranchNameMock,
  getRepoRoot: getRepoRootMock,
  getSettings: getSettingsMock,
  logger: {
    error: (...args: [string]) => {
      loggerErrorMock(...args);
    },
  },
  resolveBaseBranch: resolveBaseBranchMock,
  runStageScaffold: (opts: StageScaffoldOpts) => runStageScaffoldMock(opts),
  transportInvoker: (...args: unknown[]) => transportInvokerMock(...args),
}));

describe('implementCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('passes the implement scaffold config and transport invoker wiring', async () => {
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);

    expect(transportInvokerMock).toHaveBeenCalledWith({
      promptName: 'implement',
      pushMode: 'new-branch',
      baseRunPromptOpts: {
        repo: 'owner/repo',
        issueRef: '239',
        mode: undefined,
        agent: undefined,
        model: undefined,
      },
    });

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    expect(scaffoldArgs.repo).toBe('owner/repo');
    expect(scaffoldArgs.issueNumber).toBe('239');
    expect(scaffoldArgs.stage).toBe('implement');
    expect(scaffoldArgs.resultStage).toBe('implement');
    expect(scaffoldArgs.createBranch).toBe(true);
    expect(scaffoldArgs.initialFailure).toBe('propagate');
    expect(scaffoldArgs.invoker).toBe(transportInvokerFactoryMock);

    await expect(scaffoldArgs.resolveLocked()).resolves.toEqual({
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'main',
    });

    expect(getRepoRootMock).toHaveBeenCalledTimes(1);
    expect(generateBranchNameMock).toHaveBeenCalledWith('owner/repo', '239');
    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
    expect(getRepoRootMock.mock.invocationCallOrder[0]).toBeLessThan(
      generateBranchNameMock.mock.invocationCallOrder[0]
    );
    expect(generateBranchNameMock.mock.invocationCallOrder[0]).toBeLessThan(
      getSettingsMock.mock.invocationCallOrder[0]
    );
    expect(getSettingsMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveBaseBranchMock.mock.invocationCallOrder[0]
    );
  });

  it('preserves auto-selection behavior when no issue is provided', async () => {
    autoSelectIssueMock.mockResolvedValueOnce({ number: 321, title: 'Selected issue' });
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo')).resolves.toBeUndefined();

    expect(autoSelectIssueMock).toHaveBeenCalledWith('owner/repo', 'shipper:planned');
    expect(loggerErrorMock).toHaveBeenCalledWith('Auto-selected #321: Selected issue');
    const transportInvokerArgs = transportInvokerMock.mock.calls[0]?.[0] as
      | { baseRunPromptOpts: { issueRef: string } }
      | undefined;
    expect(transportInvokerArgs?.baseRunPromptOpts.issueRef).toBe('321');
    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: '321' })
    );
  });

  it('maps stage helper failures onto process.exitCode at the CLI boundary', async () => {
    runStageScaffoldMock.mockResolvedValueOnce({
      success: false,
      exitCode: 17,
      error: 'agent exited',
    });
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(17);
  });
});
