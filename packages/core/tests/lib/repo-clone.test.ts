import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (
  err: Error | null,
  stdout?: string | Buffer,
  stderr?: string | Buffer
) => void;

function gitProbeError(
  message: string,
  stderr = message,
  extra?: Record<string, unknown>
): Error & { stderr: string } {
  return Object.assign(new Error(message), { stderr }, extra);
}

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
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, '', '');
      }
    );
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, '', '');
      }
    );
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(ensureRepoClone('owner/repo')).resolves.toBe(clonePath);

    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['reset', '--hard'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      'git',
      ['clean', '-fdx'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(mockGh).toHaveBeenCalledWith(['repo', 'sync', '--source', 'owner/repo'], {
      cwd: clonePath,
    });
    expect(execFileMock.mock.invocationCallOrder[2]).toBeLessThan(
      mockGh.mock.invocationCallOrder[0]
    );
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('still resets and cleans an already-clean existing clone before syncing', async () => {
    const clonePath = getRepoClonePath('owner/repo');
    mockAccess.mockResolvedValue();
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, 'true\n', '');
      }
    );
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, '', '');
      }
    );
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, '', '');
      }
    );
    mockGh.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(ensureRepoClone('owner/repo')).resolves.toBe(clonePath);

    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['reset', '--hard'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      'git',
      ['clean', '-fdx'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(mockGh).toHaveBeenCalledWith(['repo', 'sync', '--source', 'owner/repo'], {
      cwd: clonePath,
    });
    expect(execFileMock.mock.invocationCallOrder[2]).toBeLessThan(
      mockGh.mock.invocationCallOrder[0]
    );
  });

  it('rethrows git reset failures before cleaning or syncing', async () => {
    const clonePath = getRepoClonePath('owner/repo');
    const resetError = new Error('git reset failed');
    mockAccess.mockResolvedValue();
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, 'true\n', '');
      }
    );
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(resetError);
      }
    );

    await expect(ensureRepoClone('owner/repo')).rejects.toBe(resetError);

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['reset', '--hard'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock.mock.calls).not.toContainEqual([
      'git',
      ['clean', '-fdx'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function),
    ]);
    expect(mockGh).not.toHaveBeenCalled();
  });

  it('rethrows git clean failures before syncing', async () => {
    const clonePath = getRepoClonePath('owner/repo');
    const cleanError = new Error('git clean failed');
    mockAccess.mockResolvedValue();
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, 'true\n', '');
      }
    );
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(null, '', '');
      }
    );
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: { cwd?: string; encoding?: string }, cb) => {
        cb(cleanError);
      }
    );

    await expect(ensureRepoClone('owner/repo')).rejects.toBe(cleanError);

    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['reset', '--hard'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      'git',
      ['clean', '-fdx'],
      { cwd: clonePath, encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(mockGh).not.toHaveBeenCalled();
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
    expect(execFileMock).not.toHaveBeenCalled();
    expect(mockGh).toHaveBeenCalledWith(['repo', 'clone', 'owner/repo', clonePath]);
  });

  it.each(['core.bare = true', 'missing .git', 'corrupt .git / broken gitlink'])(
    'removes and re-clones when the existing clone is an invalid worktree (%s)',
    async (scenario) => {
      const clonePath = getRepoClonePath('owner/repo');
      mockAccess.mockResolvedValue();
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        if (scenario === 'core.bare = true') {
          cb(null, 'false\n', '');
          return;
        }

        if (scenario === 'missing .git') {
          cb(gitProbeError('fatal: not a git repository (or any of the parent directories): .git'));
          return;
        }

        cb(gitProbeError('fatal: invalid gitfile format: /tmp/owner/repo/.git'));
      });
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
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenNthCalledWith(
        1,
        'git',
        ['rev-parse', '--is-inside-work-tree'],
        { cwd: clonePath, encoding: 'utf-8' },
        expect.any(Function)
      );
      expect(mockGh).toHaveBeenCalledWith(['repo', 'clone', 'owner/repo', clonePath]);
      expect(mockGh).not.toHaveBeenCalledWith(['repo', 'sync', '--source', 'owner/repo'], {
        cwd: clonePath,
      });
    }
  );

  it('rethrows unexpected git probe failures without removing the clone', async () => {
    const clonePath = getRepoClonePath('owner/repo');
    const probeError = gitProbeError('spawn git ENOENT', '', { code: 'ENOENT' });
    mockAccess.mockResolvedValue();
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(probeError);
    });

    await expect(ensureRepoClone('owner/repo')).rejects.toBe(probeError);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockGh).not.toHaveBeenCalledWith(['repo', 'sync', '--source', 'owner/repo'], {
      cwd: clonePath,
    });
    expect(mockGh).not.toHaveBeenCalledWith(['repo', 'clone', 'owner/repo', clonePath]);
  });
});
