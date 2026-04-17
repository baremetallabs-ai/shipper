import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunPromptOpts } from '../../../core/src/lib/prompt-runner.js';
import type { StageScaffoldOpts } from '../../../core/src/lib/stage-scaffold.js';
import { parsePrFilesPages } from '../../../core/src/lib/gh-schemas.js';

const autoSelectPrForStageMock = vi.fn();
const getBranchForPRMock = vi.fn(() => Promise.resolve('shipper/10-feature'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();
const parseDiffHunksMock =
  vi.fn<
    (diff: string) => Map<string, { left: Array<[number, number]>; right: Array<[number, number]> }>
  >();
const resolveRefMock = vi.fn(() => Promise.resolve({ prNumber: '42', issueNumber: '10' }));
const runPromptMock = vi.fn<(name: string, opts: RunPromptOpts) => Promise<number>>(() =>
  Promise.resolve(0)
);
const runStageScaffoldMock = vi.fn<(opts: StageScaffoldOpts) => Promise<void>>(() =>
  Promise.resolve()
);
const writeContextFileMock = vi.fn<
  (wtPath: string, filename: string, content: string) => Promise<void>
>(() => Promise.resolve());
const loggerErrorMock = vi.fn<(message: string) => void>();
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

vi.mock('../../../core/src/lib/prompt-runner.js', () => {
  return {
    runPrompt: (name: string, opts: RunPromptOpts) => runPromptMock(name, opts),
  };
});

vi.mock('@dnsquared/shipper-core', async () => {
  const stageScaffold = await vi.importActual<
    typeof import('../../../core/src/lib/stage-scaffold.js')
  >('../../../core/src/lib/stage-scaffold.js');
  return {
    autoSelectPrForStage: autoSelectPrForStageMock,
    getBranchForPR: getBranchForPRMock,
    getRepoRoot: getRepoRootMock,
    gh: (...args: [string[]]) => ghMock(...args),
    logger: {
      error: (...args: [string]) => {
        loggerErrorMock(...args);
      },
    },
    parseDiffHunks: (...args: [string]) => parseDiffHunksMock(...args),
    parsePrFilesPages,
    resolveRef: resolveRefMock,
    runStageScaffold: (opts: StageScaffoldOpts) => runStageScaffoldMock(opts),
    simpleInvoker: stageScaffold.simpleInvoker,
    writeContextFile: (...args: [string, string, string]) => writeContextFileMock(...args),
  };
});

describe('prReviewCommand', () => {
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
    parseDiffHunksMock.mockReturnValue(parsedDiffHunks);
  });

  it('passes the pr-review scaffold config and preserves pre-lock ref resolution', async () => {
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();

    expect(resolveRefMock).toHaveBeenCalledWith(repo, '42', 'both');
    expect(resolveRefMock.mock.invocationCallOrder[0]).toBeLessThan(
      runStageScaffoldMock.mock.invocationCallOrder[0]
    );

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    expect(scaffoldArgs.repo).toBe(repo);
    expect(scaffoldArgs.issueNumber).toBe('10');
    expect(scaffoldArgs.stage).toBe('pr-review');
    expect(scaffoldArgs.resultStage).toBe('pr_review');
    expect(scaffoldArgs.createBranch).toBe(false);
    expect(scaffoldArgs.initialFailure).toBe('crash');
    expect(scaffoldArgs.prNumber).toEqual({ value: '42' });

    await expect(scaffoldArgs.resolveLocked()).resolves.toEqual({
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/10-feature',
    });
    expect(getBranchForPRMock).toHaveBeenCalledWith(repo, '42');
  });

  it('builds setup and prompt invocations that preserve review context parity', async () => {
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await prReviewCommand(repo, '42');

    const scaffoldArgs = runStageScaffoldMock.mock.calls[0]?.[0];
    expect(scaffoldArgs).toBeDefined();
    if (!scaffoldArgs) {
      throw new Error('Expected scaffold arguments');
    }

    const invoker = scaffoldArgs.invoker({
      wtPath: '/tmp/fake-wt',
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/10-feature',
      baseBranch: undefined,
    });

    await expect(invoker.setup?.()).resolves.toEqual({
      prFiles: new Set(['src/file.ts']),
      diffHunks: parsedDiffHunks,
    });
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

    await expect(invoker.initial()).resolves.toBe(0);
    expect(runPromptMock).toHaveBeenCalledWith('pr_review', {
      repo,
      issueRef: '10',
      prRef: '42',
      cwd: '/tmp/fake-wt',
      mode: undefined,
      agent: undefined,
      model: undefined,
    });

    runPromptMock.mockResolvedValueOnce(0);
    await expect(invoker.retry('Fix result')).resolves.toBe(0);
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

  it('preserves auto-selection behavior when no PR is provided', async () => {
    autoSelectPrForStageMock.mockResolvedValueOnce({
      pr: '84',
      issue: { number: 321, title: 'Selected issue' },
    });
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo)).resolves.toBeUndefined();

    expect(autoSelectPrForStageMock).toHaveBeenCalledWith(
      repo,
      'shipper:pr-open',
      "No PRs ready for review. Run 'shipper pr open' first."
    );
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Auto-selected PR #84 (issue #321: Selected issue)'
    );
    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: '321',
        prNumber: { value: '84' },
      })
    );
  });
});
