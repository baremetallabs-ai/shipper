import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync:
    vi.fn<
      (
        cmd: string,
        args: string[],
        opts?: Record<string, unknown>
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await vi.importActual<typeof import('node:util')>('node:util');
  const mockedExecFile = Object.assign(
    (...args: unknown[]) => {
      void mockExecFileAsync(...(args as Parameters<typeof mockExecFileAsync>));
    },
    {
      [promisify.custom]: (...args: unknown[]) =>
        mockExecFileAsync(...(args as Parameters<typeof mockExecFileAsync>)),
    }
  );

  return {
    ...actual,
    execFile: mockedExecFile,
  };
});

const { resolveAndEnterRepoDir } = await import('../src/repo-dir.js');

describe('resolveAndEnterRepoDir', () => {
  const originalCwd = process.cwd();
  const originalChdir = process.chdir.bind(process);
  const originalRepoDir = process.env.SHIPPER_REPO_DIR;
  const tempDirs: string[] = [];
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    mockExecFileAsync.mockReset();
    delete process.env.SHIPPER_REPO_DIR;
    process.chdir(originalCwd);
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrWriteSpy.mockRestore();
    process.chdir(originalCwd);

    if (originalRepoDir === undefined) {
      delete process.env.SHIPPER_REPO_DIR;
    } else {
      process.env.SHIPPER_REPO_DIR = originalRepoDir;
    }

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('uses the startup cwd when SHIPPER_REPO_DIR is unset', async () => {
    process.chdir(await makeTempDir('repo-dir-unset-'));
    const startupCwd = process.cwd();
    mockExecFileAsync.mockResolvedValue({ stdout: `${startupCwd}\n`, stderr: '' });

    await expect(resolveAndEnterRepoDir()).resolves.toBe(startupCwd);

    expect(process.cwd()).toBe(startupCwd);
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], {
      cwd: startupCwd,
    });
    expect(stderrWriteSpy).toHaveBeenCalledOnce();
    expect(stderrWriteSpy).toHaveBeenCalledWith(`shipper mcp: repo dir = ${startupCwd}\n`);
  });

  it('throws the fallback non-repo error when SHIPPER_REPO_DIR is unset', async () => {
    process.chdir(await makeTempDir('repo-dir-unset-fail-'));
    const startupCwd = process.cwd();
    mockExecFileAsync.mockRejectedValue(new Error('not a git repo'));

    await expect(resolveAndEnterRepoDir()).rejects.toThrow(
      `repo dir is not a git repository: ${startupCwd}`
    );

    expect(process.cwd()).toBe(startupCwd);
    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });

  it.each(['', '   \n\t   '])(
    'treats %j as an unset SHIPPER_REPO_DIR value',
    async (repoDirValue) => {
      process.chdir(await makeTempDir('repo-dir-empty-'));
      const startupCwd = process.cwd();
      process.env.SHIPPER_REPO_DIR = repoDirValue;
      mockExecFileAsync.mockResolvedValue({ stdout: `${startupCwd}\n`, stderr: '' });

      await expect(resolveAndEnterRepoDir()).resolves.toBe(startupCwd);

      expect(process.cwd()).toBe(startupCwd);
      expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], {
        cwd: startupCwd,
      });
      expect(stderrWriteSpy).toHaveBeenCalledWith(`shipper mcp: repo dir = ${startupCwd}\n`);
    }
  );

  it('resolves relative SHIPPER_REPO_DIR values against the startup cwd', async () => {
    process.chdir(await makeTempDir('repo-dir-relative-start-'));
    const startupCwd = process.cwd();
    const repoDir = path.join(startupCwd, 'nested', 'repo');
    await mkdir(repoDir, { recursive: true });
    process.env.SHIPPER_REPO_DIR = './nested/repo';
    mockExecFileAsync.mockResolvedValue({ stdout: `${repoDir}\n`, stderr: '' });

    await expect(resolveAndEnterRepoDir()).resolves.toBe(repoDir);

    expect(process.cwd()).toBe(repoDir);
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoDir,
    });
    expect(stderrWriteSpy).toHaveBeenCalledWith(`shipper mcp: repo dir = ${repoDir}\n`);
  });

  it('rejects missing absolute SHIPPER_REPO_DIR paths before running git', async () => {
    const missingPath = path.join(await makeTempDir('repo-dir-missing-root-'), 'missing');
    process.env.SHIPPER_REPO_DIR = missingPath;

    await expect(resolveAndEnterRepoDir()).rejects.toThrow(
      `SHIPPER_REPO_DIR path does not exist: ${missingPath}`
    );

    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(stderrWriteSpy).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(originalCwd);
  });

  it('rejects non-directory absolute SHIPPER_REPO_DIR paths before running git', async () => {
    const tempRoot = await makeTempDir('repo-dir-file-root-');
    const filePath = path.join(tempRoot, 'not-a-directory');
    await writeFile(filePath, 'file');
    process.env.SHIPPER_REPO_DIR = filePath;

    await expect(resolveAndEnterRepoDir()).rejects.toThrow(
      `SHIPPER_REPO_DIR path does not exist: ${filePath}`
    );

    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(stderrWriteSpy).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(originalCwd);
  });

  it('rejects existing non-repo absolute SHIPPER_REPO_DIR paths', async () => {
    const repoDir = await makeTempDir('repo-dir-non-repo-');
    process.env.SHIPPER_REPO_DIR = repoDir;
    mockExecFileAsync.mockRejectedValue(new Error('not a git repo'));

    await expect(resolveAndEnterRepoDir()).rejects.toThrow(
      `SHIPPER_REPO_DIR is not a git repository: ${repoDir}`
    );

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoDir,
    });
    expect(stderrWriteSpy).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(originalCwd);
  });

  it('surfaces git permission failures as missing-path errors', async () => {
    const repoDir = await makeTempDir('repo-dir-git-eacces-');
    process.env.SHIPPER_REPO_DIR = repoDir;
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );

    await expect(resolveAndEnterRepoDir()).rejects.toThrow(
      `SHIPPER_REPO_DIR path does not exist: ${repoDir}`
    );

    expect(stderrWriteSpy).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(originalCwd);
  });

  it('surfaces chdir failures as missing-path errors', async () => {
    const repoDir = await makeTempDir('repo-dir-chdir-eacces-');
    process.env.SHIPPER_REPO_DIR = repoDir;
    mockExecFileAsync.mockResolvedValue({ stdout: `${repoDir}\n`, stderr: '' });
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation((...args) => {
      if (args[0] === repoDir) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }

      originalChdir(...args);
    });

    await expect(resolveAndEnterRepoDir()).rejects.toThrow(
      `SHIPPER_REPO_DIR path does not exist: ${repoDir}`
    );

    chdirSpy.mockRestore();

    expect(stderrWriteSpy).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(originalCwd);
  });
});
