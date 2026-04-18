import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRunResult, StageScaffoldOpts } from '@dnsquared/shipper-core';

const autoSelectPrForStageMock = vi.fn();
const getBranchForPRMock = vi.fn(() => Promise.resolve('shipper/10-feature'));
const getRepoRootMock = vi.fn(() => Promise.resolve('/tmp/fake-repo'));
const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();
const parseDiffHunksMock =
  vi.fn<
    (diff: string) => Map<string, { left: Array<[number, number]>; right: Array<[number, number]> }>
  >();
const parsePrFilesPagesMock = vi.fn<(raw: string) => Array<Array<{ filename: string }>>>(() => [
  [{ filename: 'src/file.ts' }],
]);
const resolveRefMock = vi.fn(() => Promise.resolve({ prNumber: '42', issueNumber: '10' }));
const runStageScaffoldMock = vi.fn<(opts: StageScaffoldOpts) => Promise<StageRunResult>>(() =>
  Promise.resolve({ success: true, exitCode: 0, verdict: 'accept' })
);
const simpleInvokerFactoryMock = vi.fn();
const simpleInvokerMock = vi.fn(() => simpleInvokerFactoryMock);
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

vi.mock('@dnsquared/shipper-core', () => ({
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
  parsePrFilesPages: (...args: [string]) => parsePrFilesPagesMock(...args),
  resolveRef: resolveRefMock,
  runStageScaffold: (opts: StageScaffoldOpts) => runStageScaffoldMock(opts),
  simpleInvoker: (...args: unknown[]) => simpleInvokerMock(...args),
  writeContextFile: (...args: [string, string, string]) => writeContextFileMock(...args),
}));

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
    parsePrFilesPagesMock.mockReturnValue([[{ filename: 'src/file.ts' }]]);
  });

  it('passes the pr-review scaffold config and simple invoker wiring', async () => {
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);

    expect(resolveRefMock).toHaveBeenCalledWith(repo, '42', 'both');
    expect(resolveRefMock.mock.invocationCallOrder[0]).toBeLessThan(
      runStageScaffoldMock.mock.invocationCallOrder[0]
    );
    expect(simpleInvokerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptName: 'pr_review',
        baseRunPromptOpts: {
          repo,
          issueRef: '10',
          prRef: '42',
          mode: undefined,
          agent: undefined,
          model: undefined,
        },
      })
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
    expect(scaffoldArgs.invoker).toBe(simpleInvokerFactoryMock);

    await expect(scaffoldArgs.resolveLocked()).resolves.toEqual({
      repoRoot: '/tmp/fake-repo',
      branch: 'shipper/10-feature',
    });
    expect(getBranchForPRMock).toHaveBeenCalledWith(repo, '42');
  });

  it('writes review context files via the setup callback passed to simpleInvoker', async () => {
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await prReviewCommand(repo, '42');

    const simpleInvokerArgs = simpleInvokerMock.mock.calls[0]?.[0] as
      | {
          setup?: (wtPath: string) => Promise<
            | {
                prFiles?: Set<string>;
                diffHunks?: Map<
                  string,
                  { left: Array<[number, number]>; right: Array<[number, number]> }
                >;
              }
            | undefined
          >;
        }
      | undefined;
    expect(simpleInvokerArgs?.setup).toBeDefined();

    const setupResult = await simpleInvokerArgs?.setup?.('/tmp/fake-wt');

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
    expect(parsePrFilesPagesMock).toHaveBeenCalledWith('[[{"filename":"src/file.ts"}]]');
    expect(setupResult).toEqual({
      prFiles: new Set(['src/file.ts']),
      diffHunks: parsedDiffHunks,
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
    const simpleInvokerArgs = simpleInvokerMock.mock.calls[0]?.[0] as
      | { baseRunPromptOpts: { issueRef: string; prRef: string } }
      | undefined;
    expect(simpleInvokerArgs?.baseRunPromptOpts).toEqual(
      expect.objectContaining({ issueRef: '321', prRef: '84' })
    );
    expect(runStageScaffoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: '321', prNumber: { value: '84' } })
    );
  });

  it('maps stage helper failures onto process.exitCode at the CLI boundary', async () => {
    runStageScaffoldMock.mockResolvedValueOnce({
      success: false,
      exitCode: 21,
      error: 'agent exited',
    });
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(21);
  });
});
