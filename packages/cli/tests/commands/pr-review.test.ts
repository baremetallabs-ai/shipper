import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@dnsquared/shipper-core', () => ({
  resolveRef: vi.fn(),
  autoSelectPrForStage: vi.fn(),
  runPrompt: vi.fn(),
  withStageHooks: vi.fn(
    async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
  ),
  withIssueLock: vi.fn(
    async (_repo: unknown, _issue: unknown, fn: () => Promise<unknown>) => await fn()
  ),
}));

import { resolveRef, runPrompt } from '@dnsquared/shipper-core';

const mockResolveRef = vi.mocked(resolveRef);
const mockRunPrompt = vi.mocked(runPrompt);
const repo = 'owner/repo';

describe('prReviewCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
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

  it('passes issueNumber as issueRef to runPrompt', async () => {
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);

    expect(mockResolveRef).toHaveBeenCalledWith(repo, '42', 'both');
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'pr_review',
      expect.objectContaining({
        repo,
        issueRef: '10',
        prRef: '42',
      })
    );
  });
});
