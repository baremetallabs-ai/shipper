import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const generateBranchNameMock = vi.fn(async () => 'shipper/239-branch');
const getRepoRootMock = vi.fn(async () => '/tmp/fake-repo');
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(async () => 'main');
const runPromptMock = vi.fn(async () => 0);
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
  formatConflictContext: formatConflictContextMock,
  generateBranchName: generateBranchNameMock,
  getRepoRoot: getRepoRootMock,
  getSettings: getSettingsMock,
  resolveBaseBranch: resolveBaseBranchMock,
  runPrompt: runPromptMock,
  withGitTransport: withGitTransportMock,
  withIssueLock: withIssueLockMock,
  withStageHooks: withStageHooksMock,
  withWorktree: withWorktreeMock,
}));

describe('implementCommand', () => {
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

  it('resolves the base branch and forwards conflict context through transport', async () => {
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);

    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
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
    expect(runPromptMock).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        userInput: 'formatted conflict context',
      })
    );
  });

  it('forwards raw push failure text through transport without conflict formatting', async () => {
    withGitTransportMock.mockImplementationOnce(
      async (
        _opts: unknown,
        fn: (conflictContext?: unknown, pushError?: string) => Promise<unknown>
      ) => await fn(undefined, 'git push -u origin HEAD exited with code 1:\npre-push hook failed')
    );
    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand('owner/repo', '239')).resolves.toBeUndefined();

    expect(formatConflictContextMock).not.toHaveBeenCalled();
    expect(runPromptMock).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({
        repo: 'owner/repo',
        issueRef: '239',
        cwd: '/tmp/fake-wt',
        userInput: 'git push -u origin HEAD exited with code 1:\npre-push hook failed',
      })
    );
  });
});
