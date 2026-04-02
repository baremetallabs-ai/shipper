import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const generateBranchNameMock = vi.fn(() => Promise.resolve('shipper/123-branch'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const handleAgentCrashMock = vi.fn(() => Promise.resolve());
const validatedResult = {
  verdict: 'accept' as const,
  comment: '.shipper/output/comment-123.md',
};
const processResultMock = vi.fn(() => Promise.resolve(validatedResult));
const retryOnInvalidOutputMock = vi.fn<
  (opts: {
    cwd: string;
    stage: string;
    retry: (message: string) => Promise<number>;
  }) => Promise<typeof validatedResult>
>(() => Promise.resolve(validatedResult));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('main'));
const runPromptMock = vi.fn(() => Promise.resolve(0));
const scrubOutputDirMock = vi.fn(() => Promise.resolve());
const loggerMock = {
  log: (message: string) => {
    console.log(`[shipper] ${message}`);
  },
  warn: (message: string) => {
    console.warn(`[shipper] ${message}`);
  },
  error: (message: string) => {
    console.error(`[shipper] ${message}`);
  },
};
const withIssueLockMock = vi.fn((_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) =>
  fn()
);
const withStageHooksMock = vi.fn((_stage: unknown, _env: unknown, fn: () => Promise<unknown>) =>
  fn()
);
const withWorktreeMock = vi.fn((_opts: unknown, fn: (wtPath: string) => Promise<unknown>) =>
  fn('/tmp/fake-wt')
);

vi.mock('@dnsquared/shipper-core', () => ({
  logger: loggerMock,
  autoSelectIssue: autoSelectIssueMock,
  generateBranchName: generateBranchNameMock,
  getRepoRoot: getRepoRootMock,
  getSettings: getSettingsMock,
  handleAgentCrash: handleAgentCrashMock,
  processResult: processResultMock,
  retryOnInvalidOutput: retryOnInvalidOutputMock,
  resolveBaseBranch: resolveBaseBranchMock,
  runPrompt: runPromptMock,
  scrubOutputDir: scrubOutputDirMock,
  withIssueLock: withIssueLockMock,
  withStageHooks: withStageHooksMock,
  withWorktree: withWorktreeMock,
}));

describe('planCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('runs the planning stage inside a worktree and processes results there', async () => {
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(generateBranchNameMock).toHaveBeenCalledWith('owner/repo', '123');
    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
    expect(withStageHooksMock).toHaveBeenCalledWith(
      'plan',
      { issueNumber: '123', branchName: 'shipper/123-branch' },
      expect.any(Function)
    );
    expect(withWorktreeMock).toHaveBeenCalledWith(
      {
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/123-branch',
        createBranch: true,
        baseBranch: 'main',
        issueNumber: '123',
        stage: 'plan',
      },
      expect.any(Function)
    );
    expect(scrubOutputDirMock).toHaveBeenCalledWith('/tmp/fake-wt');
    expect(runPromptMock).toHaveBeenCalledWith('plan', {
      repo: 'owner/repo',
      issueRef: '123',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    const retryCall = retryOnInvalidOutputMock.mock.calls[0]?.[0] as
      | { cwd: string; stage: string; retry: (message: string) => Promise<number> }
      | undefined;
    expect(retryCall?.cwd).toBe('/tmp/fake-wt');
    expect(retryCall?.stage).toBe('plan');
    expect(retryCall?.retry).toEqual(expect.any(Function));
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'plan',
      cwd: '/tmp/fake-wt',
      result: validatedResult,
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();

    runPromptMock.mockResolvedValueOnce(9);
    await expect(retryCall?.retry('Fix result')).resolves.toBe(9);
    expect(runPromptMock).toHaveBeenLastCalledWith('plan', {
      repo: 'owner/repo',
      issueRef: '123',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
  });

  it('reports non-zero prompt exits and skips output validation', async () => {
    runPromptMock.mockResolvedValueOnce(9);
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(retryOnInvalidOutputMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '123',
      'plan',
      'Agent exited with code 9',
      'The `plan` agent run exited with code 9.'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[shipper] Agent exited with code 9');
    expect(process.exitCode).toBe(1);
  });

  it('reports protocol crashes during result processing and exits with code 1', async () => {
    processResultMock.mockRejectedValueOnce(new Error('Missing result.json'));
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(retryOnInvalidOutputMock).toHaveBeenCalledTimes(1);
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '123',
      'plan',
      'Missing result.json'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[shipper] Missing result.json');
    expect(process.exitCode).toBe(1);
  });

  it('fails hard when worktree creation fails', async () => {
    withWorktreeMock.mockRejectedValueOnce(new Error('worktree add failed'));
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).rejects.toThrow('worktree add failed');

    expect(runPromptMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
  });
});
