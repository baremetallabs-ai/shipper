import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoSelectPrForStageMock = vi.fn();
const getBranchForPRMock = vi.fn(async () => 'shipper/10-feature');
const getRepoRootMock = vi.fn(async () => '/tmp/fake-repo');
const ghMock = vi.fn();
const handleAgentCrashMock = vi.fn(async () => {});
const processResultMock = vi.fn(async () => ({
  verdict: 'accept',
  comment: '.shipper/output/comment-10.md',
}));
const resolveRefMock = vi.fn(async () => ({ prNumber: '42', issueNumber: '10' }));
const runPromptMock = vi.fn(async () => 0);
const scrubOutputDirMock = vi.fn(async () => {});
const withIssueLockMock = vi.fn(
  async (_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => await fn()
);
const withStageHooksMock = vi.fn(
  async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
);
const withWorktreeMock = vi.fn(
  async (_opts: unknown, fn: (wtPath: string) => Promise<unknown>) => await fn('/tmp/fake-wt')
);
const writeContextFileMock = vi.fn(async () => {});
const repo = 'owner/repo';

vi.mock('@dnsquared/shipper-core', () => ({
  autoSelectPrForStage: autoSelectPrForStageMock,
  getBranchForPR: getBranchForPRMock,
  getRepoRoot: getRepoRootMock,
  gh: ghMock,
  handleAgentCrash: handleAgentCrashMock,
  processResult: processResultMock,
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

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    ghMock
      .mockResolvedValueOnce({ stdout: 'diff --git a/file b/file', stderr: '' })
      .mockResolvedValueOnce({ stdout: '[{"filename":"src/file.ts"}]', stderr: '' })
      .mockResolvedValueOnce({
        stdout:
          '{"headRefOid":"abc123","author":{"login":"author"},"title":"PR","headRefName":"branch"}',
        stderr: '',
      });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
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
      'diff --git a/file b/file'
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
    expect(runPromptMock).toHaveBeenCalledWith('pr_review', {
      repo,
      issueRef: '10',
      prRef: '42',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
    });
    expect(processResultMock).toHaveBeenCalledWith({
      repo,
      issueNumber: '10',
      stage: 'pr_review',
      cwd: '/tmp/fake-wt',
      prNumber: '42',
    });
    expect(handleAgentCrashMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports protocol crashes and exits with code 1', async () => {
    processResultMock.mockRejectedValueOnce(new Error('Missing result.json'));
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();

    expect(handleAgentCrashMock).toHaveBeenCalledWith(
      repo,
      '10',
      'pr_review',
      'Missing result.json'
    );
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
