import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@dnsquared/shipper-core', () => ({
  gh: vi.fn(),
  resolveRef: vi.fn(),
  autoSelectPrForStage: vi.fn(),
  handleAgentCrash: vi.fn(),
  processResult: vi.fn(),
  runPrompt: vi.fn(),
  scrubOutputDir: vi.fn(),
  withStageHooks: vi.fn(
    async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
  ),
  withIssueLock: vi.fn(
    async (_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => await fn()
  ),
  writeContextFile: vi.fn(),
}));

import {
  gh,
  handleAgentCrash,
  processResult,
  resolveRef,
  runPrompt,
  scrubOutputDir,
  writeContextFile,
} from '@dnsquared/shipper-core';

const mockGh = vi.mocked(gh);
const mockHandleAgentCrash = vi.mocked(handleAgentCrash);
const mockProcessResult = vi.mocked(processResult);
const mockResolveRef = vi.mocked(resolveRef);
const mockRunPrompt = vi.mocked(runPrompt);
const mockScrubOutputDir = vi.mocked(scrubOutputDir);
const mockWriteContextFile = vi.mocked(writeContextFile);
const repo = 'owner/repo';

describe('prReviewCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockGh
      .mockResolvedValueOnce({ stdout: 'diff --git a/file b/file', stderr: '' })
      .mockResolvedValueOnce({ stdout: '[{"filename":"src/file.ts"}]', stderr: '' })
      .mockResolvedValueOnce({
        stdout:
          '{"headRefOid":"abc123","author":{"login":"author"},"title":"PR","headRefName":"branch"}',
        stderr: '',
      });
    mockHandleAgentCrash.mockResolvedValue();
    mockProcessResult.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-10.md',
    });
    mockResolveRef.mockResolvedValue({ prNumber: '42', issueNumber: '10' });
    mockRunPrompt.mockResolvedValue(0);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
  });

  it('writes review context before running the prompt and processes the result afterward', async () => {
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    expect(mockResolveRef).toHaveBeenCalledWith(repo, '42', 'both');
    expect(mockScrubOutputDir).toHaveBeenCalledWith(process.cwd());
    expect(mockGh).toHaveBeenNthCalledWith(1, ['pr', 'diff', '42', '-R', repo]);
    expect(mockGh).toHaveBeenNthCalledWith(2, [
      'api',
      `repos/${repo}/pulls/42/files`,
      '--paginate',
      '--slurp',
      '--jq',
      'add',
    ]);
    expect(mockGh).toHaveBeenNthCalledWith(3, [
      'pr',
      'view',
      '42',
      '-R',
      repo,
      '--json',
      'headRefOid,author,title,headRefName',
    ]);
    expect(mockWriteContextFile).toHaveBeenNthCalledWith(
      1,
      process.cwd(),
      'pr-diff.patch',
      'diff --git a/file b/file'
    );
    expect(mockWriteContextFile).toHaveBeenNthCalledWith(
      2,
      process.cwd(),
      'pr-files.json',
      '[{"filename":"src/file.ts"}]'
    );
    expect(mockWriteContextFile).toHaveBeenNthCalledWith(
      3,
      process.cwd(),
      'pr-metadata.json',
      '{"headRefOid":"abc123","author":{"login":"author"},"title":"PR","headRefName":"branch"}'
    );
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'pr_review',
      expect.objectContaining({
        repo,
        issueRef: '10',
        prRef: '42',
      })
    );
    expect(mockProcessResult).toHaveBeenCalledWith({
      repo,
      issueNumber: '10',
      stage: 'pr_review',
      cwd: process.cwd(),
      prNumber: '42',
    });
    expect(mockHandleAgentCrash).not.toHaveBeenCalled();
  });

  it('reports protocol crashes and exits with code 1', async () => {
    mockProcessResult.mockRejectedValueOnce(new Error('Missing result.json'));
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();

    expect(mockHandleAgentCrash).toHaveBeenCalledWith(
      repo,
      '10',
      'pr_review',
      'Missing result.json'
    );
    expect(process.exitCode).toBe(1);
  });
});
