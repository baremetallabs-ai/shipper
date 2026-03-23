import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const findBranchForIssueMock = vi.fn(() => Promise.resolve('shipper/239-branch'));
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const handleAgentCrashMock = vi.fn(() => Promise.resolve());
const validatedResult = {
  verdict: 'accept' as const,
  comment: '.shipper/output/comment-239.md',
};
const processResultMock = vi.fn(() => Promise.resolve(validatedResult));
const retryOnInvalidOutputMock = vi.fn<
  (opts: {
    cwd: string;
    stage: string;
    retry: (message: string) => Promise<number>;
  }) => Promise<typeof validatedResult>
>(() => Promise.resolve(validatedResult));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('release/2026'));
const resolveRefMock = vi.fn(() => Promise.resolve({ issueNumber: '239' }));
const runPromptMock = vi.fn(() => Promise.resolve(0));
const scrubOutputDirMock = vi.fn(() => Promise.resolve());
const withGitTransportMock = vi.fn(
  (_opts: unknown, fn: (conflictContext?: unknown, pushError?: string) => Promise<unknown>) =>
    fn({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
      ],
    })
);
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
  findBranchForIssue: findBranchForIssueMock,
  formatConflictContext: formatConflictContextMock,
  getRepoRoot: getRepoRootMock,
  getSettings: getSettingsMock,
  handleAgentCrash: handleAgentCrashMock,
  processResult: processResultMock,
  retryOnInvalidOutput: retryOnInvalidOutputMock,
  resolveBaseBranch: resolveBaseBranchMock,
  resolveRef: resolveRefMock,
  runPrompt: runPromptMock,
  scrubOutputDir: scrubOutputDirMock,
  withGitTransport: withGitTransportMock,
  withIssueLock: withIssueLockMock,
  withStageHooks: withStageHooksMock,
  withWorktree: withWorktreeMock,
}));

describe('prOpenCommand', () => {
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

  it('routes the resolved base branch through transport and forwards conflict context', async () => {
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    expect(resolveRefMock).toHaveBeenCalledWith('owner/repo', '239', 'issue');
    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
    expect(scrubOutputDirMock).toHaveBeenCalledWith('/tmp/fake-wt');
    expect(withGitTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        wtPath: '/tmp/fake-wt',
        repoRoot: '/tmp/fake-repo',
        baseBranch: 'release/2026',
        pushMode: 'force-with-lease',
      }),
      expect.any(Function)
    );
    expect(formatConflictContextMock).toHaveBeenCalled();
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_open',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        baseBranch: 'release/2026',
        userInput: 'formatted conflict context',
      })
    );
    const retryCall = retryOnInvalidOutputMock.mock.calls[0]?.[0] as
      | { cwd: string; stage: string; retry: (message: string) => Promise<number> }
      | undefined;
    expect(retryCall?.cwd).toBe('/tmp/fake-wt');
    expect(retryCall?.stage).toBe('pr_open');
    expect(retryCall?.retry).toEqual(expect.any(Function));
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '239',
      stage: 'pr_open',
      cwd: '/tmp/fake-wt',
      result: validatedResult,
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();

    withGitTransportMock.mockImplementationOnce(
      (_opts: unknown, fn: (conflictContext?: unknown, pushError?: string) => Promise<unknown>) =>
        fn()
    );

    await expect(retryCall?.retry('Fix result')).resolves.toBe(0);
    expect(withGitTransportMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        wtPath: '/tmp/fake-wt',
        repoRoot: '/tmp/fake-repo',
        baseBranch: 'release/2026',
        pushMode: 'force-with-lease',
      }),
      expect.any(Function)
    );
    expect(runPromptMock).toHaveBeenLastCalledWith('pr_open', {
      repo: 'owner/repo',
      issueRef: '239',
      cwd: '/tmp/fake-wt',
      baseBranch: 'release/2026',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
  });

  it('forwards raw push failure text without conflict formatting', async () => {
    withGitTransportMock.mockImplementationOnce(
      async (
        _opts: unknown,
        fn: (conflictContext?: unknown, pushError?: string) => Promise<unknown>
      ) => fn(undefined, 'git push --force-with-lease exited with code 1:\npre-push hook failed')
    );
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(formatConflictContextMock).not.toHaveBeenCalled();
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_open',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        userInput: 'git push --force-with-lease exited with code 1:\npre-push hook failed',
      })
    );
  });

  it('reports protocol crashes and exits with code 1', async () => {
    processResultMock.mockRejectedValueOnce(new Error('Missing result.json'));
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '239',
      'pr_open',
      'Missing result.json'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('Missing result.json');
    expect(process.exitCode).toBe(1);
  });

  it('skips result processing when transport returns a non-zero exit code', async () => {
    withGitTransportMock.mockResolvedValueOnce(1);
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(retryOnInvalidOutputMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
