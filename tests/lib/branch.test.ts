import { describe, it, expect, vi } from 'vitest';
import { generateBranchName } from '../../src/lib/branch.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_cmd: string, args: string[]) => {
    if (args.includes('--jq')) {
      return 'Add Login Flow\n';
    }
    return '';
  }),
}));

describe('generateBranchName', () => {
  it('generates a slug from the issue title', () => {
    const result = generateBranchName('42');
    expect(result).toBe('42-add-login-flow');
  });

  it('strips leading # from issue ref', () => {
    const result = generateBranchName('#42');
    expect(result).toBe('42-add-login-flow');
  });

  it('handles special characters in title', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValueOnce('Fix: login & signup (v2)!!!\n');

    const result = generateBranchName('10');
    expect(result).toBe('10-fix-login-signup-v2');
  });

  it('truncates long slugs', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValueOnce('a'.repeat(100) + '\n');

    const result = generateBranchName('7');
    expect(result.length).toBeLessThanOrEqual(53); // "7-" + 50 chars max
  });

  it('falls back to implement when title fetch fails', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('gh failed');
    });

    const result = generateBranchName('99');
    expect(result).toBe('99-implement');
  });
});
