import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const generateBranchNameMock = vi.fn((_repo: string, issueRef: string) =>
  Promise.resolve(`shipper/${issueRef}-branch`)
);
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const printAutoSummaryMock = vi.fn();
const resolveModeMock = vi.fn((_step: string, override?: string) => override ?? 'default');
const runPromptMock = vi.fn(() => Promise.resolve(0));
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
  autoSelectIssue: autoSelectIssueMock,
  generateBranchName: generateBranchNameMock,
  getRepoRoot: getRepoRootMock,
  resolveMode: resolveModeMock,
  runPrompt: runPromptMock,
  withIssueLock: withIssueLockMock,
  withStageHooks: withStageHooksMock,
  withWorktree: withWorktreeMock,
}));

vi.mock('../../src/commands/ship.js', () => ({
  printAutoSummary: printAutoSummaryMock,
}));

describe('groomCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    resolveModeMock.mockImplementation((_step: string, override?: string) => override ?? 'default');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
  });

  it('runs a single issue inside a worktree on the generated branch', async () => {
    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand('owner/repo', '123')).resolves.toBeUndefined();

    expect(getRepoRootMock).toHaveBeenCalledTimes(1);
    expect(generateBranchNameMock).toHaveBeenCalledWith('owner/repo', '123');
    expect(withStageHooksMock).toHaveBeenCalledWith(
      'groom',
      { issueNumber: '123', branchName: 'shipper/123-branch' },
      expect.any(Function)
    );
    expect(withWorktreeMock).toHaveBeenCalledWith(
      {
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/123-branch',
        createBranch: true,
        issueNumber: '123',
        stage: 'groom',
      },
      expect.any(Function)
    );
    expect(runPromptMock).toHaveBeenCalledWith('groom', {
      repo: 'owner/repo',
      issueRef: '123',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    expect(process.exitCode).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('creates a separate worktree for each issue in auto mode', async () => {
    autoSelectIssueMock
      .mockResolvedValueOnce({ number: 101, title: 'First issue' })
      .mockResolvedValueOnce({ number: 102, title: 'Second issue' })
      .mockResolvedValueOnce(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand('owner/repo', undefined, { auto: true })).resolves.toBeUndefined();

    expect(withWorktreeMock).toHaveBeenCalledTimes(2);
    expect(withWorktreeMock).toHaveBeenNthCalledWith(
      1,
      {
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/101-branch',
        createBranch: true,
        issueNumber: '101',
        stage: 'groom',
      },
      expect.any(Function)
    );
    expect(withWorktreeMock).toHaveBeenNthCalledWith(
      2,
      {
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/102-branch',
        createBranch: true,
        issueNumber: '102',
        stage: 'groom',
      },
      expect.any(Function)
    );
    expect(runPromptMock).toHaveBeenNthCalledWith(
      1,
      'groom',
      expect.objectContaining({ issueRef: '101', cwd: '/tmp/fake-wt' })
    );
    expect(runPromptMock).toHaveBeenNthCalledWith(
      2,
      'groom',
      expect.objectContaining({ issueRef: '102', cwd: '/tmp/fake-wt' })
    );
    expect(process.exitCode).toBe(0);

    logSpy.mockRestore();
  });

  it('rejects explicitly headless grooming before doing any work', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(
      groomCommand('owner/repo', '123', { auto: false, mode: 'headless' })
    ).rejects.toThrow('exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      'Error: groom does not support headless mode. Grooming requires interactive input.'
    );
    expect(autoSelectIssueMock).not.toHaveBeenCalled();
    expect(withWorktreeMock).not.toHaveBeenCalled();
    expect(runPromptMock).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('rejects settings-resolved headless grooming before doing any work', async () => {
    resolveModeMock.mockReturnValueOnce('headless');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand('owner/repo', '123', { auto: false })).rejects.toThrow('exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      'Error: groom does not support headless mode. Grooming requires interactive input.'
    );
    expect(autoSelectIssueMock).not.toHaveBeenCalled();
    expect(withWorktreeMock).not.toHaveBeenCalled();
    expect(runPromptMock).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('fails hard when worktree creation fails', async () => {
    withWorktreeMock.mockRejectedValueOnce(new Error('worktree add failed'));
    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand('owner/repo', '123')).rejects.toThrow('worktree add failed');

    expect(runPromptMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
