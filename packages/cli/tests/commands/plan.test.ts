import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const generateBranchNameMock = vi.fn(async () => 'shipper/123-branch');
const getRepoRootMock = vi.fn(async () => '/tmp/fake-repo');
const handleAgentCrashMock = vi.fn(async () => {});
const processResultMock = vi.fn(async () => ({
  verdict: 'accept',
  comment: '.shipper/output/comment-123.md',
}));
const runPromptMock = vi.fn(async () => 9);
const scrubOutputDirMock = vi.fn(async () => {});
const withIssueLockMock = vi.fn(
  async (_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => await fn()
);
const withStageHooksMock = vi.fn(
  async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
);
const withWorktreeMock = vi.fn(
  async (_opts: unknown, fn: (wtPath: string) => Promise<unknown>) => await fn('/tmp/fake-wt')
);

vi.mock('@dnsquared/shipper-core', () => ({
  autoSelectIssue: autoSelectIssueMock,
  generateBranchName: generateBranchNameMock,
  getRepoRoot: getRepoRootMock,
  handleAgentCrash: handleAgentCrashMock,
  processResult: processResultMock,
  runPrompt: runPromptMock,
  scrubOutputDir: scrubOutputDirMock,
  withIssueLock: withIssueLockMock,
  withStageHooks: withStageHooksMock,
  withWorktree: withWorktreeMock,
}));

describe('planCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
  });

  it('runs the planning stage inside a worktree and processes results there', async () => {
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(generateBranchNameMock).toHaveBeenCalledWith('owner/repo', '123');
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
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '123',
      stage: 'plan',
      cwd: '/tmp/fake-wt',
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports protocol crashes and exits with code 1', async () => {
    processResultMock.mockRejectedValueOnce(new Error('Invalid result.json'));
    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '123',
      'plan',
      'Invalid result.json'
    );
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
