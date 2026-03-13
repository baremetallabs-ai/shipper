import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ShipperCore = typeof import('@dnsquared/shipper-core');

const autoSelectIssueMock = vi.fn();
const findBranchForIssueMock = vi.fn(() => Promise.resolve('shipper/239-branch'));
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const getSettingsMock = vi.fn(() => ({ defaultBaseBranch: 'main' }));
const resolveBaseBranchMock = vi.fn(() => Promise.resolve('release/2026'));
const resolveRefMock = vi.fn<ShipperCore['resolveRef']>(() =>
  Promise.resolve({ issueNumber: '239' })
);
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
  findBranchForIssue: findBranchForIssueMock,
  formatConflictContext: formatConflictContextMock,
  getRepoRoot: getRepoRootMock,
  getSettings: getSettingsMock,
  resolveBaseBranch: resolveBaseBranchMock,
  resolveRef: resolveRefMock,
  runPrompt: runPromptMock,
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
    expect(process.exitCode).toBe(0);

    expect(resolveRefMock).toHaveBeenCalledWith('owner/repo', '239', 'issue');
    expect(resolveBaseBranchMock).toHaveBeenCalledWith('owner/repo', 'main');
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
  });
});
