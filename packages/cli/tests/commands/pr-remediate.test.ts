import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSettingsMock = vi.fn();
const fetchChecksMock = vi.fn();
const resolveRefMock = vi.fn();
const autoSelectPrForStageMock = vi.fn();
const formatConflictContextMock = vi.fn(() => 'formatted conflict context');
const runPromptMock = vi.fn();
const withGitTransportMock = vi.fn(
  async (_opts: unknown, fn: (conflictContext?: unknown) => Promise<unknown>) =>
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
const withStageHooksMock = vi.fn(
  async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
);
const withIssueLockMock = vi.fn(
  async (_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => await fn()
);
const withWorktreeMock = vi.fn(
  async (_opts: unknown, fn: (wtPath: string) => Promise<unknown>) => await fn('/tmp/fake-wt')
);
const getBranchForPRMock = vi.fn(async () => 'shipper/10-feature');
const getRepoRootMock = vi.fn(async () => '/tmp/fake-repo');
const ghMock = vi.fn();
const sleepMsMock = vi.fn(async () => {});
const repo = 'owner/repo';
vi.mock('@dnsquared/shipper-core', () => ({
  resolveRef: resolveRefMock,
  autoSelectPrForStage: autoSelectPrForStageMock,
  formatConflictContext: formatConflictContextMock,
  runPrompt: runPromptMock,
  withGitTransport: withGitTransportMock,
  withStageHooks: withStageHooksMock,
  withIssueLock: withIssueLockMock,
  withWorktree: withWorktreeMock,
  getBranchForPR: getBranchForPRMock,
  getRepoRoot: getRepoRootMock,
  gh: ghMock,
  sleepMs: sleepMsMock,
  getSettings: () => getSettingsMock(),
  fetchChecks: (...args: unknown[]) => fetchChecksMock(...args),
  classifyChecks: (checks: Array<{ state: string }>) => ({
    pending: checks.filter((check) => check.state !== 'COMPLETED'),
    total: checks.length,
  }),
}));

describe('prRemediateCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    resolveRefMock.mockResolvedValue({ prNumber: '42', issueNumber: '10' });
    runPromptMock.mockResolvedValue(0);
    ghMock.mockImplementation(async (args: string[]) => {
      if (args.includes('baseRefName')) {
        return {
          stdout: JSON.stringify({ baseRefName: 'release/2026' }),
          stderr: '',
        };
      }

      return {
        stdout: JSON.stringify({ createdAt: new Date().toISOString() }),
        stderr: '',
      };
    });
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'timer', timeoutMinutes: 0 },
      hooks: {},
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
  });

  it('passes issueNumber (not PR number) as issueRef to runPrompt', async () => {
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);

    expect(resolveRefMock).toHaveBeenCalledWith(repo, '42', 'both');
    expect(fetchChecksMock).not.toHaveBeenCalled();
    expect(getBranchForPRMock).toHaveBeenCalledWith(repo, '42');
    expect(withIssueLockMock).toHaveBeenCalledWith(repo, '10', expect.any(Function));
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
      'pr_remediate',
      expect.objectContaining({
        repo,
        issueRef: '10',
        prRef: '42',
        userInput: 'formatted conflict context',
      })
    );
  });

  it('in timer mode with timeoutMinutes 0, skips wait and runs prompt', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'timer', timeoutMinutes: 0 },
      hooks: {},
    });
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(runPromptMock).toHaveBeenCalled();
    expect(fetchChecksMock).not.toHaveBeenCalled();
  });

  it('in checks mode, polls and proceeds when all checks complete', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 1 },
      hooks: {},
    });
    fetchChecksMock.mockResolvedValue([
      { name: 'build', state: 'COMPLETED', bucket: 'pass' },
      { name: 'test', state: 'COMPLETED', bucket: 'pass' },
    ]);

    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(runPromptMock).toHaveBeenCalled();
    expect(fetchChecksMock).toHaveBeenCalledWith(repo, '42');
  });

  it('in checks mode with zero checks, retries then proceeds', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 1 },
      hooks: {},
    });
    // Return empty array for all calls (initial + 3 grace retries)
    fetchChecksMock.mockResolvedValue([]);

    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    await expect(prRemediateCommand(repo, '42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(runPromptMock).toHaveBeenCalled();
    // Initial call + 3 grace retries = 4 calls
    expect(fetchChecksMock).toHaveBeenCalledTimes(4);
    expect(logMock).toHaveBeenCalledWith('No CI checks found. Proceeding.');
    logMock.mockRestore();
  });
});
