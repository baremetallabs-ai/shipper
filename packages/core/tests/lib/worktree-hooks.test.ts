import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock =
  vi.fn<
    (
      command: string,
      args: string[],
      execOpts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => void
  >();
const spawnMock =
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => EventEmitter>();
const accessMock = vi.fn<(path: string) => Promise<void>>();
const mkdirMock = vi.fn<(path: string, options?: Record<string, unknown>) => Promise<void>>();
const runAdvisoryHookMock =
  vi.fn<
    (label: string, command: string, env: Record<string, string>, cwd?: string) => Promise<void>
  >();
const runWorktreeHookMock =
  vi.fn<(event: string, env: Record<string, string>, cwd: string) => Promise<void>>();
const getSettingsMock = vi.fn<() => Record<string, unknown>>();
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      execFileMock(...args);
    },
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, randomUUID: () => 'desktop-session-uuid' };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: (...args: unknown[]) => accessMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/user' };
});

vi.mock('../../src/lib/hooks.js', () => ({
  runAdvisoryHook: (...args: unknown[]) => runAdvisoryHookMock(...args),
  runWorktreeHook: (...args: unknown[]) => runWorktreeHookMock(...args),
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
}));

function mockSpawnSuccess(): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter();
    globalThis.queueMicrotask(() => {
      child.emit('close', 0);
    });
    return child;
  });
}

function queueExecResult(opts: { code?: number; stdout?: string; stderr?: string } = {}): void {
  const { code = 0, stdout = '', stderr = '' } = opts;
  execFileMock.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _execOpts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      globalThis.queueMicrotask(() => {
        if (code === 0) {
          callback(null, stdout, stderr);
          return;
        }

        const error = new Error(`exit:${code}`) as Error & {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        callback(error, stdout, stderr);
      });
    }
  );
}

function gitArgsFromExecCalls(): string[][] {
  return execFileMock.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args);
}

function gitArgsFromSpawnCalls(): string[][] {
  return spawnMock.mock.calls
    .filter(([command]) => command === 'git')
    .map(([, args]) => args ?? []);
}

const { createDesktopGroomWorktree, createWorktree, withWorktree } =
  await import('../../src/lib/worktree.js');

const WORKTREES_DIR = path.join('/home/user', '.shipper', 'worktrees');
const defaultOpts = {
  repoRoot: '/repos/my-repo',
  branch: 'shipper/42-add-feature',
  createBranch: true,
  baseBranch: 'main',
  issueNumber: '42',
  stage: 'implement',
};
const expectedWtPath = path.join(WORKTREES_DIR, 'my-repo--wt--shipper-42-add-feature');
const expectedDesktopGroomWtPath = path.join(
  WORKTREES_DIR,
  'my-repo--desktop-groom--42--desktop-session-uuid'
);
const expectedNpmCachePath = path.join(expectedWtPath, '.shipper', 'tmp', '.npm-cache');
const expectedXdgCachePath = path.join(expectedWtPath, '.shipper', 'tmp', '.cache');
const expectedTurboCachePath = path.join(expectedWtPath, '.shipper', 'tmp', '.turbo-cache');

let originalNpmConfigCache: string | undefined;
let originalXdgCacheHome: string | undefined;
let originalUvCacheDir: string | undefined;
let originalTurboCacheDir: string | undefined;

function restoreEnvVar(
  key: 'NPM_CONFIG_CACHE' | 'XDG_CACHE_HOME' | 'UV_CACHE_DIR' | 'TURBO_CACHE_DIR',
  value: string | undefined
): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

beforeEach(() => {
  originalNpmConfigCache = process.env.NPM_CONFIG_CACHE;
  originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  originalUvCacheDir = process.env.UV_CACHE_DIR;
  originalTurboCacheDir = process.env.TURBO_CACHE_DIR;

  execFileMock.mockReset();
  spawnMock.mockReset();
  accessMock.mockReset();
  mkdirMock.mockReset();
  runAdvisoryHookMock.mockReset();
  runWorktreeHookMock.mockReset();
  getSettingsMock.mockReset();
  errorMock.mockClear();
  errorMock.mockImplementation(() => {});

  accessMock.mockRejectedValue(new Error('ENOENT'));
  mkdirMock.mockResolvedValue(undefined);
  execFileMock.mockImplementation((_cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === defaultOpts.branch) {
      const error = new Error('exit:128') as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      error.code = 128;
      error.stdout = '';
      error.stderr = 'fatal: Needed a single revision';
      cb(error, '', 'fatal: Needed a single revision');
      return;
    }
    cb(null, '', '');
  });
  runAdvisoryHookMock.mockResolvedValue(undefined);
  runWorktreeHookMock.mockResolvedValue(undefined);
  getSettingsMock.mockReturnValue({});
  mockSpawnSuccess();
});

afterEach(() => {
  restoreEnvVar('NPM_CONFIG_CACHE', originalNpmConfigCache);
  restoreEnvVar('XDG_CACHE_HOME', originalXdgCacheHome);
  restoreEnvVar('UV_CACHE_DIR', originalUvCacheDir);
  restoreEnvVar('TURBO_CACHE_DIR', originalTurboCacheDir);
});

describe('createDesktopGroomWorktree', () => {
  it('creates a detached UUID-suffixed worktree and removes it during cleanup', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin main refspec
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify origin/main

    const result = await createDesktopGroomWorktree({
      repoRoot: '/repos/my-repo',
      issueNumber: '42',
      baseBranch: 'main',
    });

    expect(result.wtPath).toBe(expectedDesktopGroomWtPath);
    expect(mkdirMock).toHaveBeenCalledWith(WORKTREES_DIR, { recursive: true });
    expect(gitArgsFromExecCalls()).toEqual([
      ['worktree', 'prune'],
      ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main'],
      ['rev-parse', '--verify', 'origin/main'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['worktree', 'add', '--detach', expectedDesktopGroomWtPath, 'origin/main'],
    ]);

    await result.cleanup();

    expect(gitArgsFromSpawnCalls()).toEqual([
      ['worktree', 'add', '--detach', expectedDesktopGroomWtPath, 'origin/main'],
      ['worktree', 'remove', '--force', expectedDesktopGroomWtPath],
    ]);
  });

  it('fails fast with a descriptive error when fetching the desktop groom base fails', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult({ code: 1, stderr: 'fatal: network down' }); // git fetch origin main refspec

    await expect(
      createDesktopGroomWorktree({
        repoRoot: '/repos/my-repo',
        issueNumber: '42',
        baseBranch: 'main',
      })
    ).rejects.toThrow(
      'Failed to fetch origin/main before worktree creation: git fetch origin refs/heads/main:refs/remotes/origin/main exited with code 1:\nfatal: network down'
    );

    expect(gitArgsFromSpawnCalls()).toEqual([]);
  });

  it('fails fast with a descriptive error when the desktop groom base ref is missing', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin
    queueExecResult({ code: 128, stderr: 'fatal: ambiguous argument origin/main' });

    await expect(
      createDesktopGroomWorktree({
        repoRoot: '/repos/my-repo',
        issueNumber: '42',
        baseBranch: 'main',
      })
    ).rejects.toThrow(
      "Remote ref origin/main does not exist after fetching origin. Ensure the branch 'main' exists on origin.\ngit rev-parse --verify origin/main exited with code 128:\nfatal: ambiguous argument origin/main"
    );

    expect(gitArgsFromSpawnCalls()).toEqual([]);
  });

  it('removes a desktop groom worktree only once when cleanup is called repeatedly', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin main refspec
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify origin/main

    const result = await createDesktopGroomWorktree({
      repoRoot: '/repos/my-repo',
      issueNumber: '42',
      baseBranch: 'main',
    });

    await result.cleanup();
    await result.cleanup();

    expect(
      gitArgsFromSpawnCalls().filter((args) => args[0] === 'worktree' && args[1] === 'remove')
    ).toHaveLength(1);
  });
});

describe('createWorktree', () => {
  it('fetches origin and branches from origin/<baseBranch> when creating a new worktree branch', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin main refspec
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify origin/main
    queueExecResult({ code: 128, stderr: 'fatal: Needed a single revision' }); // branch missing

    await expect(createWorktree(defaultOpts)).resolves.toEqual({
      wtPath: expectedWtPath,
      didResetToBase: false,
    });

    expect(gitArgsFromExecCalls()).toEqual([
      ['worktree', 'prune'],
      ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main'],
      ['rev-parse', '--verify', 'origin/main'],
      ['rev-parse', '--verify', 'shipper/42-add-feature'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['worktree', 'add', '-b', 'shipper/42-add-feature', expectedWtPath, 'origin/main'],
    ]);
  });

  it('throws when createBranch is true without baseBranch', async () => {
    await expect(
      createWorktree({
        ...defaultOpts,
        baseBranch: undefined,
      })
    ).rejects.toThrow('baseBranch is required when createBranch is true');
  });

  it('fails fast with a descriptive error when fetching origin fails', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult({ code: 1, stderr: 'fatal: network down' }); // git fetch origin main refspec

    await expect(createWorktree(defaultOpts)).rejects.toThrow(
      'Failed to fetch origin/main before worktree creation: git fetch origin refs/heads/main:refs/remotes/origin/main exited with code 1:\nfatal: network down'
    );

    expect(gitArgsFromSpawnCalls()).toEqual([]);
  });

  it('fails fast with a descriptive error when origin/<baseBranch> cannot be resolved', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin
    queueExecResult({ code: 128, stderr: 'fatal: ambiguous argument origin/main' });

    await expect(createWorktree(defaultOpts)).rejects.toThrow(
      "Remote ref origin/main does not exist after fetching origin. Ensure the branch 'main' exists on origin.\ngit rev-parse --verify origin/main exited with code 128:\nfatal: ambiguous argument origin/main"
    );

    expect(gitArgsFromSpawnCalls()).toEqual([]);
  });

  it('keeps createBranch false behavior unchanged', async () => {
    queueExecResult(); // git worktree prune

    await expect(
      createWorktree({
        ...defaultOpts,
        createBranch: false,
        baseBranch: undefined,
      })
    ).resolves.toEqual({
      wtPath: expectedWtPath,
      didResetToBase: false,
    });

    expect(gitArgsFromExecCalls()).toEqual([['worktree', 'prune']]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['worktree', 'add', expectedWtPath, 'shipper/42-add-feature'],
    ]);
  });

  it('resets a reused branch to origin/<baseBranch> after creating the worktree', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin main refspec
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify origin/main
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify branch
    queueExecResult({ stdout: 'HEAD is now at abc123 reset\n' }); // git reset --hard origin/main

    await expect(createWorktree({ ...defaultOpts, stage: 'design' })).resolves.toEqual({
      wtPath: expectedWtPath,
      didResetToBase: true,
    });

    expect(gitArgsFromExecCalls()).toEqual([
      ['worktree', 'prune'],
      ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main'],
      ['rev-parse', '--verify', 'origin/main'],
      ['rev-parse', '--verify', 'shipper/42-add-feature'],
      ['reset', '--hard', 'origin/main'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['worktree', 'add', expectedWtPath, 'shipper/42-add-feature'],
    ]);
  });

  it('does not reset a reused branch outside design and plan', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin main refspec
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify origin/main
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify branch

    await expect(createWorktree(defaultOpts)).resolves.toEqual({
      wtPath: expectedWtPath,
      didResetToBase: false,
    });

    expect(gitArgsFromExecCalls()).toEqual([
      ['worktree', 'prune'],
      ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main'],
      ['rev-parse', '--verify', 'origin/main'],
      ['rev-parse', '--verify', 'shipper/42-add-feature'],
    ]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['worktree', 'add', expectedWtPath, 'shipper/42-add-feature'],
    ]);
  });
});

describe('withWorktree', () => {
  it('emits the full worktree marker sequence on the happy path', async () => {
    getSettingsMock.mockReturnValue({
      installCommand: 'npm ci',
    });

    const callOrder: string[] = [];
    errorMock.mockImplementation((message?: unknown) => {
      callOrder.push(String(message));
    });
    runAdvisoryHookMock.mockImplementation((label: string) => {
      callOrder.push(label);
      return Promise.resolve();
    });
    runWorktreeHookMock.mockImplementation((event: string) => {
      callOrder.push(event);
      return Promise.resolve();
    });

    const result = await withWorktree(defaultOpts, () => {
      callOrder.push('callback');
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(callOrder).toEqual([
      '[shipper]   worktree: creating branch',
      '[shipper]   worktree: installing dependencies',
      'Install dependencies',
      '[shipper]   worktree: running setup hooks',
      'worktree-setup',
      '[shipper]   worktree: running agent',
      'callback',
      'worktree-teardown',
      '[shipper]   worktree: teardown complete',
    ]);
  });

  it('runs setup before the callback and teardown after it', async () => {
    const callOrder: string[] = [];
    runWorktreeHookMock.mockImplementation((event: string) => {
      callOrder.push(event);
      return Promise.resolve();
    });

    const result = await withWorktree(defaultOpts, () => {
      callOrder.push('callback');
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(callOrder).toEqual(['worktree-setup', 'callback', 'worktree-teardown']);
  });

  it('passes the expected hook environment and cwd', async () => {
    await withWorktree(defaultOpts, () => Promise.resolve(undefined));

    expect(runWorktreeHookMock).toHaveBeenNthCalledWith(
      1,
      'worktree-setup',
      {
        SHIPPER_STAGE: 'implement',
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      },
      expectedWtPath
    );
  });

  it('runs installCommand before setup hooks', async () => {
    getSettingsMock.mockReturnValue({
      installCommand: 'npm ci',
    });

    const callOrder: string[] = [];
    runAdvisoryHookMock.mockImplementation((label: string) => {
      callOrder.push(label);
      return Promise.resolve();
    });
    runWorktreeHookMock.mockImplementation((event: string) => {
      callOrder.push(event);
      return Promise.resolve();
    });

    await withWorktree(defaultOpts, () => {
      callOrder.push('callback');
      return Promise.resolve();
    });

    expect(callOrder).toEqual([
      'Install dependencies',
      'worktree-setup',
      'callback',
      'worktree-teardown',
    ]);
  });

  it('omits the install marker when no install command is configured', async () => {
    await withWorktree(defaultOpts, () => Promise.resolve(undefined));

    expect(errorMock.mock.calls).toEqual([
      ['[shipper]   worktree: creating branch'],
      ['[shipper]   worktree: running setup hooks'],
      ['[shipper]   worktree: running agent'],
      ['[shipper]   worktree: teardown complete'],
    ]);
  });

  it('logs the reset marker before setup hooks when reusing an existing branch', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin main refspec
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify origin/main
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify branch
    queueExecResult({ stdout: 'HEAD is now at abc123 reset\n' }); // git reset --hard origin/main

    await withWorktree({ ...defaultOpts, stage: 'plan' }, () => Promise.resolve(undefined));

    expect(errorMock.mock.calls).toEqual([
      ['[shipper]   worktree: creating branch'],
      ['[shipper]   worktree: resetting to origin/main'],
      ['[shipper]   worktree: running setup hooks'],
      ['[shipper]   worktree: running agent'],
      ['[shipper]   worktree: teardown complete'],
    ]);
  });

  it('sets NPM_CONFIG_CACHE to a worktree-local path inside the callback', async () => {
    process.env.NPM_CONFIG_CACHE = '/original-cache';

    await withWorktree(defaultOpts, (wtPath) => {
      expect(process.env.NPM_CONFIG_CACHE).toBe(path.join(wtPath, '.shipper', 'tmp', '.npm-cache'));
      return Promise.resolve();
    });

    expect(process.env.NPM_CONFIG_CACHE).toBe('/original-cache');
  });

  it('sets XDG_CACHE_HOME to a worktree-local path inside the callback', async () => {
    process.env.XDG_CACHE_HOME = '/original-xdg-cache';

    await withWorktree(defaultOpts, (wtPath) => {
      expect(process.env.XDG_CACHE_HOME).toBe(path.join(wtPath, '.shipper', 'tmp', '.cache'));
      return Promise.resolve();
    });

    expect(process.env.XDG_CACHE_HOME).toBe('/original-xdg-cache');
  });

  it('sets TURBO_CACHE_DIR to a worktree-local path inside the callback', async () => {
    process.env.TURBO_CACHE_DIR = '/original-turbo-cache';

    await withWorktree(defaultOpts, (wtPath) => {
      expect(process.env.TURBO_CACHE_DIR).toBe(
        path.join(wtPath, '.shipper', 'tmp', '.turbo-cache')
      );
      return Promise.resolve();
    });

    expect(process.env.TURBO_CACHE_DIR).toBe('/original-turbo-cache');
  });

  it('lets worktreeEnv override the built-in TURBO_CACHE_DIR default', async () => {
    getSettingsMock.mockReturnValue({
      worktreeEnv: { TURBO_CACHE_DIR: '/custom-turbo-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.TURBO_CACHE_DIR).toBe('/custom-turbo-cache');
      return Promise.resolve();
    });
  });

  it('applies worktreeEnv values as-is and restores them after cleanup', async () => {
    process.env.NPM_CONFIG_CACHE = '/original-cache';
    process.env.XDG_CACHE_HOME = '/original-xdg-cache';
    process.env.UV_CACHE_DIR = '/original-uv-cache';
    process.env.TURBO_CACHE_DIR = '/original-turbo-cache';
    getSettingsMock.mockReturnValue({
      worktreeEnv: { UV_CACHE_DIR: '.uv-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.NPM_CONFIG_CACHE).toBe(expectedNpmCachePath);
      expect(process.env.XDG_CACHE_HOME).toBe(expectedXdgCachePath);
      expect(process.env.TURBO_CACHE_DIR).toBe(expectedTurboCachePath);
      expect(process.env.UV_CACHE_DIR).toBe('.uv-cache');
      return Promise.resolve();
    });

    expect(process.env.NPM_CONFIG_CACHE).toBe('/original-cache');
    expect(process.env.XDG_CACHE_HOME).toBe('/original-xdg-cache');
    expect(process.env.UV_CACHE_DIR).toBe('/original-uv-cache');
    expect(process.env.TURBO_CACHE_DIR).toBe('/original-turbo-cache');
  });

  it('lets worktreeEnv override the built-in NPM_CONFIG_CACHE default', async () => {
    getSettingsMock.mockReturnValue({
      worktreeEnv: { NPM_CONFIG_CACHE: '/custom-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.NPM_CONFIG_CACHE).toBe('/custom-cache');
      return Promise.resolve();
    });
  });

  it('lets worktreeEnv override the built-in XDG_CACHE_HOME default', async () => {
    getSettingsMock.mockReturnValue({
      worktreeEnv: { XDG_CACHE_HOME: '/custom-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.XDG_CACHE_HOME).toBe('/custom-cache');
      return Promise.resolve();
    });
  });

  it('runs teardown only once when a signal fires during the callback', async () => {
    let sigintListener: (() => void) | undefined;
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT') {
        sigintListener = listener as () => void;
      }
      return process;
    });
    const removeListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);
    process.env.NPM_CONFIG_CACHE = '/before-signal';
    process.env.XDG_CACHE_HOME = '/before-signal-xdg-cache';
    process.env.UV_CACHE_DIR = '/before-signal-uv-cache';
    getSettingsMock.mockReturnValue({
      worktreeEnv: { UV_CACHE_DIR: '.uv-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.NPM_CONFIG_CACHE).toBe(expectedNpmCachePath);
      expect(process.env.XDG_CACHE_HOME).toBe(expectedXdgCachePath);
      expect(process.env.UV_CACHE_DIR).toBe('.uv-cache');
      sigintListener?.();
      return Promise.resolve();
    });

    expect(
      runWorktreeHookMock.mock.calls.filter(([event]) => event === 'worktree-teardown')
    ).toHaveLength(1);
    expect(
      errorMock.mock.calls.filter(
        ([message]) => message === '[shipper]   worktree: teardown complete'
      )
    ).toHaveLength(1);
    expect(process.env.NPM_CONFIG_CACHE).toBe('/before-signal');
    expect(process.env.XDG_CACHE_HOME).toBe('/before-signal-xdg-cache');
    expect(process.env.UV_CACHE_DIR).toBe('/before-signal-uv-cache');

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('keeps worktree env vars applied while teardown runs, then restores them after cleanup', async () => {
    process.env.NPM_CONFIG_CACHE = '/before-teardown';
    process.env.XDG_CACHE_HOME = '/before-teardown-xdg-cache';
    process.env.UV_CACHE_DIR = '/before-teardown-uv-cache';
    getSettingsMock.mockReturnValue({
      worktreeEnv: { UV_CACHE_DIR: '.uv-cache' },
    });

    runWorktreeHookMock.mockImplementation((event: string) => {
      if (event === 'worktree-teardown') {
        expect(process.env.NPM_CONFIG_CACHE).toBe(expectedNpmCachePath);
        expect(process.env.XDG_CACHE_HOME).toBe(expectedXdgCachePath);
        expect(process.env.UV_CACHE_DIR).toBe('.uv-cache');
      }
      return Promise.resolve();
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.NPM_CONFIG_CACHE).toBe(expectedNpmCachePath);
      expect(process.env.XDG_CACHE_HOME).toBe(expectedXdgCachePath);
      expect(process.env.UV_CACHE_DIR).toBe('.uv-cache');
      return Promise.resolve();
    });

    expect(process.env.NPM_CONFIG_CACHE).toBe('/before-teardown');
    expect(process.env.XDG_CACHE_HOME).toBe('/before-teardown-xdg-cache');
    expect(process.env.UV_CACHE_DIR).toBe('/before-teardown-uv-cache');
  });

  it('waits for signal-started cleanup to finish before resolving', async () => {
    let sigintListener: (() => void) | undefined;
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT') {
        sigintListener = listener as () => void;
      }
      return process;
    });
    const removeListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    let releaseTeardown: (() => void) | undefined;
    const teardownStarted = new Promise<void>((resolve) => {
      runWorktreeHookMock.mockImplementation((event: string) => {
        if (event === 'worktree-teardown') {
          resolve();
          return new Promise<void>((teardownResolve) => {
            releaseTeardown = teardownResolve;
          });
        }
        return Promise.resolve();
      });
    });

    let resolved = false;
    const worktreePromise = withWorktree(defaultOpts, () => {
      sigintListener?.();
      return Promise.resolve();
    }).then(() => {
      resolved = true;
    });

    await teardownStarted;
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseTeardown?.();
    await worktreePromise;
    expect(resolved).toBe(true);

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });
});
