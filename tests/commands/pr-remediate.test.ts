import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

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

vi.mock('../../src/lib/worktree.js', () => ({
  withWorktree: vi.fn((_opts: unknown, fn: (wtPath: string) => unknown) => fn('/tmp/fake-wt')),
}));

vi.mock('../../src/lib/branch.js', () => ({
  getBranchForPR: vi.fn(() => 'shipper/10-feature'),
  getRepoRoot: vi.fn(() => '/tmp/fake-repo'),
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: vi.fn(() => ({ prReviewWaitMinutes: 0, hooks: {} })),
}));

import { resolveRef } from '../../src/lib/github.js';
import { runPrompt } from '../../src/lib/prompt-runner.js';

const mockResolveRef = vi.mocked(resolveRef);
const mockRunPrompt = vi.mocked(runPrompt);

describe('prRemediateCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockResolveRef.mockReturnValue({ prNumber: '42', issueNumber: '10' });
    mockRunPrompt.mockReturnValue(0);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('passes issueNumber (not PR number) as issueRef to runPrompt', async () => {
    const { prRemediateCommand } = await import('../../src/commands/pr-remediate.js');

    expect(() => prRemediateCommand('42')).toThrow('exit:0');

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'pr_remediate',
      expect.objectContaining({
        issueRef: '10',
        prRef: '42',
      })
    );
  });
});
