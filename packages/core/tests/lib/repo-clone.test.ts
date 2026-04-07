import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (
  err: Error | null,
  stdout?: string | Buffer,
  stderr?: string | Buffer
) => void;

const { mockGh, mockAccess, mockMkdir, mockRm, mockWarn, execFileMock } = vi.hoisted(() => ({
  mockGh:
    vi.fn<
      (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>
    >(),
  mockAccess: vi.fn<(path: string) => Promise<void>>(),
  mockMkdir: vi.fn<(path: string, opts?: { recursive?: boolean }) => Promise<string | undefined>>(),
  mockRm: vi.fn<(path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>>(),
  mockWarn: vi.fn<(message: string) => void>(),
  execFileMock:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { cwd?: string; encoding?: string },
        callback: ExecFileCallback
      ) => void
    >(),
}));

const execFile = Object.assign(
  (...args: unknown[]) => {
    execFileMock(...args);
  },
  {
    [promisify.custom]: (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFileMock(
          ...args,
          (err: Error | null, stdout: string | Buffer = '', stderr: string | Buffer = '') => {
            if (err) {
              reject(err);
              return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        );
      }),
  }
);

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => mockGh(...(args as Parameters<typeof mockGh>)),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    warn: (message: string) => {
      mockWarn(message);
    },
  },
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: (...args: unknown[]) => mockAccess(...(args as Parameters<typeof mockAccess>)),
    mkdir: (...args: unknown[]) => mockMkdir(...(args as Parameters<typeof mockMkdir>)),
    rm: (...args: unknown[]) => mockRm(...(args as Parameters<typeof mockRm>)),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile,
  };
});

const { ensureRepoClone, getRepoClonePath } = await import('../../src/lib/repo-clone.js');

beforeEach(() => {
  mockGh.mockReset();
  mockAccess.mockReset();
  mockMkdir.mockReset();
  mockRm.mockReset();
  mockWarn.mockReset();
  execFileMock.mockReset();
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
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, 'true\n', '');
      }
    );
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(ensureRepoClone('owner/repo')).resolves.toBe(clonePath);

    expect(mockGh).toHaveBeenCalledWith(['repo', 'sync', '--source', 'owner/repo'], {
      cwd: clonePath,
    });
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
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

  it.each(['core.bare = true', 'missing .git', 'corrupt .git / broken gitlink'])(
    'removes and re-clones when the existing clone is an invalid worktree (%s)',
    async () => {
      const clonePath = getRepoClonePath('owner/repo');
      mockAccess.mockResolvedValue();
      execFileMock.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
          cb(new Error('must be run in a work tree'));
        }
      );
      mockRm.mockResolvedValue();
      mockMkdir.mockResolvedValue(undefined);
      mockGh.mockResolvedValue({ stdout: '', stderr: '' });

      await expect(ensureRepoClone('owner/repo')).resolves.toBe(clonePath);

      expect(mockWarn).toHaveBeenCalledWith(
        `Clone at ${clonePath} is not a valid git worktree, removing and re-cloning`
      );
      expect(mockRm).toHaveBeenCalledWith(clonePath, { recursive: true, force: true });
      expect(mockMkdir).toHaveBeenCalledWith(path.join(homedir(), '.shipper', 'repos', 'owner'), {
        recursive: true,
      });
      expect(mockGh).toHaveBeenCalledWith(['repo', 'clone', 'owner/repo', clonePath]);
      expect(mockGh).not.toHaveBeenCalledWith(['repo', 'sync', '--source', 'owner/repo'], {
        cwd: clonePath,
      });
    }
  );
});
