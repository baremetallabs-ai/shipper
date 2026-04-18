import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRunResult, StageScaffoldOpts } from '@dnsquared/shipper-core';

const autoSelectIssueMock = vi.fn();
const generateBranchNameMock = vi.fn(() => Promise.resolve('shipper/123-branch'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('main'));
const runStageScaffoldMock = vi.fn<(opts: StageScaffoldOpts) => Promise<StageRunResult>>(() =>
  Promise.resolve({ success: true, exitCode: 0, verdict: 'accept' })
);
const simpleInvokerFactoryMock = vi.fn();
const simpleInvokerMock = vi.fn(() => simpleInvokerFactoryMock);
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
  simpleInvoker: (...args: unknown[]) => simpleInvokerMock(...args),
}));

describe('planCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('passes the planning scaffold config and simple invoker wiring', async () => {
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);

    expect(simpleInvokerMock).toHaveBeenCalledWith({
      promptName: 'plan',
      baseRunPromptOpts: {
        repo: 'owner/repo',
        issueRef: '123',
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
    expect(scaffoldArgs.issueNumber).toBe('123');
    expect(scaffoldArgs.stage).toBe('plan');
    expect(scaffoldArgs.resultStage).toBe('plan');
    expect(scaffoldArgs.createBranch).toBe(true);
    expect(scaffoldArgs.initialFailure).toBe('crash');
    expect(scaffoldArgs.invoker).toBe(simpleInvokerFactoryMock);

    await expect(scaffoldArgs.resolveLocked()).resolves.toEqual({
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/123-branch',
      baseBranch: 'main',
    });

    expect(getRepoRootMock).toHaveBeenCalledTimes(1);
    expect(generateBranchNameMock).toHaveBeenCalledWith('owner/repo', '123');
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
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo')).resolves.toBeUndefined();

    expect(autoSelectIssueMock).toHaveBeenCalledWith('owner/repo', 'shipper:designed');
    expect(loggerErrorMock).toHaveBeenCalledWith('Auto-selected #321: Selected issue');
    const simpleInvokerArgs = simpleInvokerMock.mock.calls[0]?.[0] as
      | { baseRunPromptOpts: { issueRef: string } }
      | undefined;
    expect(simpleInvokerArgs?.baseRunPromptOpts.issueRef).toBe('321');
    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: '321' })
    );
  });

  it('maps stage helper failures onto process.exitCode at the CLI boundary', async () => {
    runStageScaffoldMock.mockResolvedValueOnce({
      success: false,
      exitCode: 11,
      error: 'agent exited',
    });
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(11);
  });
});
