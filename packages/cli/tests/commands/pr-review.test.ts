import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectPrForStageMock = vi.fn();
const getBranchForPRMock = vi.fn(() => Promise.resolve('shipper/10-feature'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const ghMock = vi.fn();
const handleAgentCrashMock = vi.fn(() => Promise.resolve());
const validatedResult = {
  verdict: 'accept' as const,
  comment: '.shipper/output/comment-10.md',
};
const processResultMock = vi.fn(() => Promise.resolve(validatedResult));
const retryOnInvalidOutputMock = vi.fn<
  (opts: {
    cwd: string;
    stage: string;
    prFiles?: Set<string>;
    diffHunks?: Map<string, { left: Array<[number, number]>; right: Array<[number, number]> }>;
    retry: (message: string) => Promise<number>;
  }) => Promise<typeof validatedResult>
>(() => Promise.resolve(validatedResult));
const resolveRefMock = vi.fn(() => Promise.resolve({ prNumber: '42', issueNumber: '10' }));
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
const withIssueLockMock = vi.fn((_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) =>
  fn()
);
const withStageHooksMock = vi.fn((_stage: unknown, _env: unknown, fn: () => Promise<unknown>) =>
  fn()
);
const withWorktreeMock = vi.fn((_opts: unknown, fn: (wtPath: string) => Promise<unknown>) =>
  fn('/tmp/fake-wt')
);
const writeContextFileMock = vi.fn(() => Promise.resolve());
const repo = 'owner/repo';
const diffFixture = [
  'diff --git a/src/file.ts b/src/file.ts',
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1,3 +1,4 @@',
  ' line 1',
  ' line 2',
  ' line 3',
  '+line 4',
].join('\n');
const parsedDiffHunks = new Map([
  [
    'src/file.ts',
    {
      left: [[1, 3]] as Array<[number, number]>,
      right: [[1, 4]] as Array<[number, number]>,
    },
  ],
]);
const parseDiffHunksMock = vi.fn(() => parsedDiffHunks);

vi.mock('@dnsquared/shipper-core', () => ({
  logger: loggerMock,
  autoSelectPrForStage: autoSelectPrForStageMock,
  getBranchForPR: getBranchForPRMock,
  getRepoRoot: getRepoRootMock,
  gh: ghMock,
  handleAgentCrash: handleAgentCrashMock,
  parseDiffHunks: parseDiffHunksMock,
  processResult: processResultMock,
  retryOnInvalidOutput: retryOnInvalidOutputMock,
  resolveRef: resolveRefMock,
  runPrompt: runPromptMock,
  scrubOutputDir: scrubOutputDirMock,
  withIssueLock: withIssueLockMock,
  withStageHooks: withStageHooksMock,
  withWorktree: withWorktreeMock,
  writeContextFile: writeContextFileMock,
}));

describe('prReviewCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    ghMock
      .mockResolvedValueOnce({ stdout: diffFixture, stderr: '' })
      .mockResolvedValueOnce({ stdout: '[[{"filename":"src/file.ts"}]]', stderr: '' })
      .mockResolvedValueOnce({
        stdout:
          '{"headRefOid":"abc123","author":{"login":"author"},"title":"PR","headRefName":"branch"}',
        stderr: '',
      });
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

  it('writes review context and processes results inside the PR head-branch worktree', async () => {
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();

    expect(resolveRefMock).toHaveBeenCalledWith(repo, '42', 'both');
    expect(getBranchForPRMock).toHaveBeenCalledWith(repo, '42');
    expect(withStageHooksMock).toHaveBeenCalledWith(
      'pr-review',
      { issueNumber: '10', branchName: 'shipper/10-feature' },
      expect.any(Function)
    );
    expect(withWorktreeMock).toHaveBeenCalledWith(
      {
        repoRoot: '/tmp/fake-repo',
        branch: 'shipper/10-feature',
        createBranch: false,
        issueNumber: '10',
        stage: 'pr-review',
      },
      expect.any(Function)
    );
    expect(scrubOutputDirMock).toHaveBeenCalledWith('/tmp/fake-wt');
    expect(ghMock).toHaveBeenNthCalledWith(1, ['pr', 'diff', '42', '-R', repo]);
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'api',
      `repos/${repo}/pulls/42/files`,
      '--paginate',
      '--slurp',
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(3, [
      'pr',
      'view',
      '42',
      '-R',
      repo,
      '--json',
      'headRefOid,author,title,headRefName',
    ]);
    expect(writeContextFileMock).toHaveBeenNthCalledWith(
      1,
      '/tmp/fake-wt',
      'pr-diff.patch',
      diffFixture
    );
    expect(writeContextFileMock).toHaveBeenNthCalledWith(
      2,
      '/tmp/fake-wt',
      'pr-files.json',
      '[{"filename":"src/file.ts"}]'
    );
    expect(writeContextFileMock).toHaveBeenNthCalledWith(
      3,
      '/tmp/fake-wt',
      'pr-metadata.json',
      '{"headRefOid":"abc123","author":{"login":"author"},"title":"PR","headRefName":"branch"}'
    );
    expect(parseDiffHunksMock).toHaveBeenCalledWith(diffFixture);
    expect(runPromptMock).toHaveBeenCalledWith('pr_review', {
      repo,
      issueRef: '10',
      prRef: '42',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    const retryCall = retryOnInvalidOutputMock.mock.calls[0]?.[0] as
      | {
          cwd: string;
          stage: string;
          prFiles?: Set<string>;
          diffHunks?: Map<
            string,
            { left: Array<[number, number]>; right: Array<[number, number]> }
          >;
          retry: (message: string) => Promise<number>;
        }
      | undefined;
    expect(retryCall?.cwd).toBe('/tmp/fake-wt');
    expect(retryCall?.stage).toBe('pr_review');
    expect(retryCall?.prFiles).toEqual(new Set(['src/file.ts']));
    expect(retryCall?.diffHunks).toEqual(parsedDiffHunks);
    expect(retryCall?.retry).toEqual(expect.any(Function));
    expect(ghMock).toHaveBeenCalledTimes(3);
    expect(processResultMock).toHaveBeenCalledWith({
      repo,
      issueNumber: '10',
      stage: 'pr_review',
      cwd: '/tmp/fake-wt',
      result: validatedResult,
      prNumber: '42',
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();

    await expect(retryCall?.retry('Fix result')).resolves.toBe(0);
    expect(runPromptMock).toHaveBeenLastCalledWith('pr_review', {
      repo,
      issueRef: '10',
      prRef: '42',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
      userInput: 'Fix result',
    });
  });

  it('reports non-zero prompt exits and skips output validation', async () => {
    runPromptMock.mockResolvedValueOnce(23);
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();

    expect(writeContextFileMock).toHaveBeenCalledTimes(3);
    expect(retryOnInvalidOutputMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      repo,
      '10',
      'pr_review',
      'Agent exited with code 23',
      'The `pr_review` agent run exited with code 23.'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[shipper] Agent exited with code 23');
    expect(process.exitCode).toBe(1);
  });

  it('fails hard when worktree creation fails', async () => {
    withWorktreeMock.mockRejectedValueOnce(new Error('worktree add failed'));
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).rejects.toThrow('worktree add failed');

    expect(runPromptMock).not.toHaveBeenCalled();
    expect(writeContextFileMock).not.toHaveBeenCalled();
    expect(processResultMock).not.toHaveBeenCalled();
  });
});
