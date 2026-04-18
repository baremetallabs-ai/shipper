import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageScaffoldOpts } from '@dnsquared/shipper-core';

const autoSelectIssueMock = vi.fn();
const findBranchForIssueMock = vi.fn(() => Promise.resolve('shipper/239-branch'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('release/2026'));
const resolveRefMock = vi.fn(() => Promise.resolve({ issueNumber: '239' }));
const runStageScaffoldMock = vi.fn<(opts: StageScaffoldOpts) => Promise<void>>(() =>
  Promise.resolve()
);
const transportInvokerFactoryMock = vi.fn();
const transportInvokerMock = vi.fn(() => transportInvokerFactoryMock);
const tryResolvePrForIssueMock = vi.fn(() => Promise.resolve(undefined));
const loggerErrorMock = vi.fn<(message: string) => void>();

vi.mock('@dnsquared/shipper-core', () => ({
  autoSelectIssue: autoSelectIssueMock,
  findBranchForIssue: findBranchForIssueMock,
  getRepoRoot: getRepoRootMock,
  getSettings: getSettingsMock,
  logger: {
    error: (...args: [string]) => {
      loggerErrorMock(...args);
    },
  },
  resolveBaseBranch: resolveBaseBranchMock,
  resolveRef: resolveRefMock,
  runStageScaffold: (opts: StageScaffoldOpts) => runStageScaffoldMock(opts),
  transportInvoker: (...args: unknown[]) => transportInvokerMock(...args),
  tryResolvePrForIssue: tryResolvePrForIssueMock,
}));

describe('prOpenCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('passes the pr-open scaffold config and transport invoker wiring', async () => {
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(resolveRefMock).toHaveBeenCalledWith('owner/repo', '239', 'issue');
    expect(tryResolvePrForIssueMock).toHaveBeenCalledWith('owner/repo', 239);
    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
    expect(resolveRefMock.mock.invocationCallOrder[0]).toBeLessThan(
      tryResolvePrForIssueMock.mock.invocationCallOrder[0]
    );
    expect(tryResolvePrForIssueMock.mock.invocationCallOrder[0]).toBeLessThan(
      getSettingsMock.mock.invocationCallOrder[0]
    );
    expect(getSettingsMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveBaseBranchMock.mock.invocationCallOrder[0]
    );
    expect(resolveBaseBranchMock.mock.invocationCallOrder[0]).toBeLessThan(
      runStageScaffoldMock.mock.invocationCallOrder[0]
    );

    expect(transportInvokerMock).toHaveBeenCalledWith({
      promptName: 'pr_open',
      pushMode: 'force-with-lease',
      baseRunPromptOpts: {
        repo: 'owner/repo',
        issueRef: '239',
        baseBranch: 'release/2026',
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
    expect(scaffoldArgs.stage).toBe('pr-open');
    expect(scaffoldArgs.resultStage).toBe('pr_open');
    expect(scaffoldArgs.createBranch).toBe(false);
    expect(scaffoldArgs.initialFailure).toBe('propagate');
    expect(scaffoldArgs.prNumber).toEqual({ value: undefined });
    expect(scaffoldArgs.invoker).toBe(transportInvokerFactoryMock);

    await expect(scaffoldArgs.resolveLocked()).resolves.toEqual({
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/239-branch',
      baseBranch: 'release/2026',
    });
    expect(findBranchForIssueMock).toHaveBeenCalledWith('239');
  });

  it('preserves the linked PR own-key shape when a PR already exists', async () => {
    tryResolvePrForIssueMock.mockResolvedValueOnce('84');
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await prOpenCommand('owner/repo', '239');

    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: { value: '84' },
      })
    );
  });

  it('preserves auto-selection behavior when no issue is provided', async () => {
    autoSelectIssueMock.mockResolvedValueOnce({ number: 321, title: 'Selected issue' });
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo')).resolves.toBeUndefined();

    expect(autoSelectIssueMock).toHaveBeenCalledWith('owner/repo', 'shipper:implemented');
    expect(loggerErrorMock).toHaveBeenCalledWith('Auto-selected #321: Selected issue');
    const transportInvokerArgs = transportInvokerMock.mock.calls[0]?.[0] as
      | { baseRunPromptOpts: { issueRef: string } }
      | undefined;
    expect(transportInvokerArgs?.baseRunPromptOpts.issueRef).toBe('321');
    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: '321' })
    );
  });
});
