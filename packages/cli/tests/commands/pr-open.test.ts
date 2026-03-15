import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const findBranchForIssueMock = vi.fn(async () => 'shipper/239-branch');
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const getRepoRootMock = vi.fn(async () => '/tmp/fake-repo');
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const handleAgentCrashMock = vi.fn(async () => {});
const processResultMock = vi.fn(async () => ({
  verdict: 'accept',
  comment: '.shipper/output/comment-239.md',
}));
const resolveBaseBranchMock = vi.fn(async () => 'release/2026');
const resolveRefMock = vi.fn(async () => ({ issueNumber: '239' }));
const runPromptMock = vi.fn(async () => 0);
const scrubOutputDirMock = vi.fn(async () => {});
const withGitTransportMock = vi.fn(
  async (_opts: unknown, fn: (conflictContext?: unknown, pushError?: string) => Promise<unknown>) =>
    await fn({
      files: ['src/conflict.ts'],
      conflicts: [
        {
          path: 'src/conflict.ts',
          markers: ['<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main'],
        },
      ],
    })
);
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
  findBranchForIssue: findBranchForIssueMock,
  formatConflictContext: formatConflictContextMock,
  getRepoRoot: getRepoRootMock,
  getSettings: getSettingsMock,
  handleAgentCrash: handleAgentCrashMock,
  processResult: processResultMock,
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
    expect(processResultMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      issueNumber: '239',
      stage: 'pr_open',
      cwd: '/tmp/fake-wt',
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
  });

  it('forwards raw push failure text without conflict formatting', async () => {
    withGitTransportMock.mockImplementationOnce(
      async (
        _opts: unknown,
        fn: (conflictContext?: unknown, pushError?: string) => Promise<unknown>
      ) =>
        await fn(undefined, 'git push --force-with-lease exited with code 1:\npre-push hook failed')
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
    expect(process.exitCode).toBe(1);
  });
});
