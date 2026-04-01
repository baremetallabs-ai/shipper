import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const generateBranchNameMock = vi.fn(() => Promise.resolve('shipper/239-branch'));
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
const truncateLargeInputMock = vi.fn((_: string, text: string, filename: string) =>
  Promise.resolve(`truncated:${filename}:${text}`)
);
const withGitTransportMock = vi.fn(
  (
    _opts: unknown,
    fn: (conflictContext?: unknown, pushError?: string, installError?: string) => Promise<unknown>
  ) =>
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
  logger: loggerMock,
  autoSelectIssue: autoSelectIssueMock,
  formatConflictContext: formatConflictContextMock,
  generateBranchName: generateBranchNameMock,
  getRepoRoot: getRepoRootMock,
  getSettings: getSettingsMock,
  handleAgentCrash: handleAgentCrashMock,
  processResult: processResultMock,
  retryOnInvalidOutput: retryOnInvalidOutputMock,
  resolveBaseBranch: resolveBaseBranchMock,
  runPrompt: runPromptMock,
  scrubOutputDir: scrubOutputDirMock,
  truncateLargeInput: truncateLargeInputMock,
  withGitTransport: withGitTransportMock,
  withIssueLock: withIssueLockMock,
  withStageHooks: withStageHooksMock,
  withWorktree: withWorktreeMock,
}));

describe('implementCommand', () => {
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

  it('resolves the base branch and forwards conflict context through transport', async () => {
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
    expect(withWorktreeMock).toHaveBeenCalledWith(
      {
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/239-branch',
        createBranch: true,
        baseBranch: 'main',
        issueNumber: '239',
        stage: 'implement',
      },
      expect.any(Function)
    );
    expect(scrubOutputDirMock).toHaveBeenCalledWith('/tmp/fake-wt');
    expect(withGitTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        wtPath: '/tmp/fake-wt',
        repoRoot: '/tmp/fake-repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      }),
      expect.any(Function)
    );
    expect(formatConflictContextMock).toHaveBeenCalledWith({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
      ],
    });
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'formatted conflict context',
      'conflict-context.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        userInput: 'truncated:conflict-context.txt:formatted conflict context',
      })
    );
    const retryCall = retryOnInvalidOutputMock.mock.calls[0]?.[0] as
      | { cwd: string; stage: string; retry: (message: string) => Promise<number> }
      | undefined;
    expect(retryCall?.cwd).toBe('/tmp/fake-wt');
    expect(retryCall?.stage).toBe('implement');
    expect(retryCall?.retry).toEqual(expect.any(Function));
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '239',
      stage: 'implement',
      cwd: '/tmp/fake-wt',
      result: validatedResult,
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();

    withGitTransportMock.mockImplementationOnce(
      (
        _opts: unknown,
        fn: (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<unknown>
      ) => fn()
    );

    await expect(retryCall?.retry('Fix result')).resolves.toBe(0);
    expect(withGitTransportMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        wtPath: '/tmp/fake-wt',
        repoRoot: '/tmp/fake-repo',
        baseBranch: 'main',
        pushMode: 'new-branch',
      }),
      expect.any(Function)
    );
    expect(runPromptMock).toHaveBeenLastCalledWith('implement', {
      repo: 'owner/repo',
      issueRef: '239',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
    expect(truncateLargeInputMock).toHaveBeenCalledTimes(1);
  });

  it('routes push failures through truncateLargeInput without conflict formatting', async () => {
    withGitTransportMock.mockImplementationOnce(
      async (
        _opts: unknown,
        fn: (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<unknown>
      ) => fn(undefined, 'git push -u origin HEAD exited with code 1:\npre-push hook failed')
    );
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(formatConflictContextMock).not.toHaveBeenCalled();
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'git push -u origin HEAD exited with code 1:\npre-push hook failed',
      'push-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        userInput:
          'truncated:push-error.txt:git push -u origin HEAD exited with code 1:\npre-push hook failed',
      })
    );
  });

  it('routes install failures through truncateLargeInput', async () => {
    withGitTransportMock.mockImplementationOnce(
      async (
        _opts: unknown,
        fn: (
          conflictContext?: unknown,
          pushError?: string,
          installError?: string
        ) => Promise<unknown>
      ) => fn(undefined, undefined, 'npm install exited with code 1')
    );
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'npm install exited with code 1',
      'install-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        userInput: 'truncated:install-error.txt:npm install exited with code 1',
      })
    );
  });

  it('reports protocol crashes and exits with code 1', async () => {
    processResultMock.mockRejectedValueOnce(new Error('Missing result.json'));
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '239',
      'implement',
      'Missing result.json'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[shipper] Missing result.json');
    expect(process.exitCode).toBe(1);
  });

  it('skips retry and result processing when transport returns a non-zero exit code', async () => {
    withGitTransportMock.mockResolvedValueOnce(1);
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(retryOnInvalidOutputMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
