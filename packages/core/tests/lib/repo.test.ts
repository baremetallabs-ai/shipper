import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGh } = vi.hoisted(() => ({
  mockGh:
    vi.fn<
      (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>
    >(),
}));

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => mockGh(...(args as Parameters<typeof mockGh>)),
}));

const { getRepoNwo } = await import('../../src/lib/repo.js');

beforeEach(() => {
  mockGh.mockReset();
});

describe('getRepoNwo', () => {
  it('returns the trimmed nameWithOwner from gh repo view', async () => {
    mockGh.mockResolvedValue({ stdout: 'owner/repo\n', stderr: '' });

    await expect(getRepoNwo()).resolves.toBe('owner/repo');
    expect(mockGh).toHaveBeenCalledWith([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '-q',
      '.nameWithOwner',
    ]);
  });

  it('wraps gh failures with repository guidance', async () => {
    mockGh.mockRejectedValue(new Error('not a github repo'));

    await expect(getRepoNwo()).rejects.toThrow(
      'Could not determine repository. Run this command from inside a GitHub repository.\n' +
        'Underlying error: not a github repo'
    );
  });
});
