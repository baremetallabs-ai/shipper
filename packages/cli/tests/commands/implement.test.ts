import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectIssueMock = vi.fn();
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const generateBranchNameMock = vi.fn(() => Promise.resolve('shipper/239-branch'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('main'));
const runPromptMock = vi.fn(() => Promise.resolve(0));
const withGitTransportMock = vi.fn(
  (_opts: unknown, fn: (conflictContext?: unknown) => Promise<unknown>) =>
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
});
