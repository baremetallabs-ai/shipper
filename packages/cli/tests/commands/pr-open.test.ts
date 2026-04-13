import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toError, toErrorMessage } from '../../../core/src/lib/errors.js';

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
const tryResolvePrForIssueMock = vi.fn(() => Promise.resolve(undefined));
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
  toError,
  toErrorMessage,
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
  tryResolvePrForIssue: tryResolvePrForIssueMock,
  truncateLargeInput: truncateLargeInputMock,
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
    expect(tryResolvePrForIssueMock).toHaveBeenCalledWith('owner/repo', 239);
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
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'formatted conflict context',
      'conflict-context.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_open',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        baseBranch: 'release/2026',
        userInput: 'truncated:conflict-context.txt:formatted conflict context',
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
      prNumber: undefined,
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
      ) => fn(undefined, 'git push --force-with-lease exited with code 1:\npre-push hook failed')
    );
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(formatConflictContextMock).not.toHaveBeenCalled();
    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'git push --force-with-lease exited with code 1:\npre-push hook failed',
      'push-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_open',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        userInput:
          'truncated:push-error.txt:git push --force-with-lease exited with code 1:\npre-push hook failed',
      })
    );
  });

  it('passes an already linked PR number through to processResult', async () => {
    tryResolvePrForIssueMock.mockResolvedValueOnce('84');
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(processResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'pr_open',
        prNumber: '84',
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
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(truncateLargeInputMock).toHaveBeenCalledWith(
      '/tmp/fake-wt',
      'npm install exited with code 1',
      'install-error.txt'
    );
    expect(runPromptMock).toHaveBeenCalledWith(
      'pr_open',
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
    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      'owner/repo',
      '239',
      'pr_open',
      'Missing result.json'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[shipper] Missing result.json');
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
