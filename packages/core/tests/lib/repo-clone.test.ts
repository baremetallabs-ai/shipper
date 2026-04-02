import { homedir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGh, mockAccess, mockMkdir } = vi.hoisted(() => ({
  mockGh:
    vi.fn<
      (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>
    >(),
  mockAccess: vi.fn<(path: string) => Promise<void>>(),
  mockMkdir: vi.fn<(path: string, opts?: { recursive?: boolean }) => Promise<string | undefined>>(),
}));

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => mockGh(...(args as Parameters<typeof mockGh>)),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: (...args: unknown[]) => mockAccess(...(args as Parameters<typeof mockAccess>)),
    mkdir: (...args: unknown[]) => mockMkdir(...(args as Parameters<typeof mockMkdir>)),
  };
});

const { ensureRepoClone, getRepoClonePath } = await import('../../src/lib/repo-clone.js');

beforeEach(() => {
  mockGh.mockReset();
  mockAccess.mockReset();
  mockMkdir.mockReset();
});

describe('getRepoClonePath', () => {
  it('returns the clone path under ~/.shipper/repos', () => {
    expect(getRepoClonePath('owner/repo')).toBe(
      path.join(homedir(), '.shipper', 'repos', 'owner/repo')
    );
  });
});

describe('ensureRepoClone', () => {
  it('syncs an existing clone', async () => {
    const clonePath = getRepoClonePath('owner/repo');
    mockAccess.mockResolvedValue();
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(ensureRepoClone('owner/repo')).resolves.toBe(clonePath);

    expect(mockGh).toHaveBeenCalledWith(['repo', 'sync', '--source', 'owner/repo'], {
      cwd: clonePath,
    });
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('creates parent directories and clones when the repo is missing', async () => {
    const clonePath = getRepoClonePath('owner/repo');
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    mockMkdir.mockResolvedValue(undefined);
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(ensureRepoClone('owner/repo')).resolves.toBe(clonePath);

    expect(mockMkdir).toHaveBeenCalledWith(path.join(homedir(), '.shipper', 'repos', 'owner'), {
      recursive: true,
    });
    expect(mockGh).toHaveBeenCalledWith(['repo', 'clone', 'owner/repo', clonePath]);
  });
});
