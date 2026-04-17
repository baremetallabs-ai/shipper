import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunPromptOpts } from '../../../core/src/lib/prompt-runner.js';
import type { StageScaffoldOpts } from '../../../core/src/lib/stage-scaffold.js';

const autoSelectIssueMock = vi.fn();
const generateBranchNameMock = vi.fn(() => Promise.resolve('shipper/123-branch'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('main'));
const runPromptMock = vi.fn<(name: string, opts: RunPromptOpts) => Promise<number>>(() =>
  Promise.resolve(0)
);
const runStageScaffoldMock = vi.fn<(opts: StageScaffoldOpts) => Promise<void>>(() =>
  Promise.resolve()
);
const loggerErrorMock = vi.fn<(message: string) => void>();

vi.mock('../../../core/src/lib/prompt-runner.js', () => {
  return {
    runPrompt: (name: string, opts: RunPromptOpts) => runPromptMock(name, opts),
  };
});

vi.mock('@dnsquared/shipper-core', async () => {
  const stageScaffold = await vi.importActual<
    typeof import('../../../core/src/lib/stage-scaffold.js')
  >('../../../core/src/lib/stage-scaffold.js');
  return {
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
    simpleInvoker: stageScaffold.simpleInvoker,
  };
});

describe('designCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('passes the design scaffold config and preserves in-lock resolution order', async () => {
    const { designCommand } = await import('../../src/commands/design.js');

    await expect(designCommand('owner/repo', '123')).resolves.toBeUndefined();

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    expect(scaffoldArgs.repo).toBe('owner/repo');
    expect(scaffoldArgs.issueNumber).toBe('123');
    expect(scaffoldArgs.stage).toBe('design');
    expect(scaffoldArgs.resultStage).toBe('design');
    expect(scaffoldArgs.createBranch).toBe(true);
    expect(scaffoldArgs.initialFailure).toBe('crash');

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

  it('builds prompt invocations that preserve design payload parity', async () => {
    const { designCommand } = await import('../../src/commands/design.js');

    await designCommand('owner/repo', '123');

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    const invoker = scaffoldArgs.invoker({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/123-branch',
      baseBranch: 'main',
    });

    expect(invoker.setup).toBeUndefined();
    await expect(invoker.initial()).resolves.toBe(0);
    expect(runPromptMock).toHaveBeenCalledWith('design', {
      repo: 'owner/repo',
      issueRef: '123',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
    });

    runPromptMock.mockResolvedValueOnce(7);
    await expect(invoker.retry('Fix result')).resolves.toBe(7);
    expect(runPromptMock).toHaveBeenLastCalledWith('design', {
      repo: 'owner/repo',
      issueRef: '123',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
  });

  it('preserves auto-selection behavior when no issue is provided', async () => {
    autoSelectIssueMock.mockResolvedValueOnce({ number: 321, title: 'Selected issue' });
    const { designCommand } = await import('../../src/commands/design.js');

    await expect(designCommand('owner/repo')).resolves.toBeUndefined();

    expect(autoSelectIssueMock).toHaveBeenCalledWith('owner/repo', 'shipper:groomed');
    expect(loggerErrorMock).toHaveBeenCalledWith('Auto-selected #321: Selected issue');
    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: '321' })
    );
  });
});
