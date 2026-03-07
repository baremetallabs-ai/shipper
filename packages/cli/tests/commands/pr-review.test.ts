import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/github.js', () => ({
  resolveRef: vi.fn(),
  autoSelectPrForStage: vi.fn(),
}));

vi.mock('../../src/lib/prompt-runner.js', () => ({
  runPrompt: vi.fn(),
}));

vi.mock('../../src/lib/hooks.js', () => ({
  withStageHooks: vi.fn((_stage: unknown, _env: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../../src/lib/lock.js', () => ({
  withIssueLock: vi.fn((_issue: unknown, fn: () => unknown) => fn()),
}));

import { resolveRef } from '../../src/lib/github.js';
import { runPrompt } from '../../src/lib/prompt-runner.js';

const mockResolveRef = vi.mocked(resolveRef);
const mockRunPrompt = vi.mocked(runPrompt);

describe('prReviewCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRef.mockReturnValue({ prNumber: '42', issueNumber: '10' });
    mockRunPrompt.mockReturnValue(0);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('passes issueNumber as issueRef to runPrompt', async () => {
    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    expect(() => prReviewCommand('42')).toThrow('exit:0');

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'pr_review',
      expect.objectContaining({
        issueRef: '10',
        prRef: '42',
      })
    );
  });
});
