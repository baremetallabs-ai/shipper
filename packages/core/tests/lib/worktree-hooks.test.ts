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

const { createWorktree, withWorktree } = await import('../../src/lib/worktree.js');

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
const expectedNpmCachePath = path.join(expectedWtPath, '.shipper', 'tmp', '.npm-cache');
const expectedXdgCachePath = path.join(expectedWtPath, '.shipper', 'tmp', '.cache');

let originalNpmConfigCache: string | undefined;
let originalXdgCacheHome: string | undefined;
let originalUvCacheDir: string | undefined;

function restoreEnvVar(
  key: 'NPM_CONFIG_CACHE' | 'XDG_CACHE_HOME' | 'UV_CACHE_DIR',
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

  execFileMock.mockReset();
  spawnMock.mockReset();
  accessMock.mockReset();
  mkdirMock.mockReset();
  runAdvisoryHookMock.mockReset();
  runWorktreeHookMock.mockReset();
  getSettingsMock.mockReset();

  accessMock.mockRejectedValue(new Error('ENOENT'));
  mkdirMock.mockResolvedValue(undefined);
  execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
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
});

describe('withWorktree', () => {
  it('fetches origin and branches from origin/<baseBranch> when creating a new worktree branch', async () => {
    queueExecResult(); // git worktree prune
    queueExecResult(); // git fetch origin
    queueExecResult({ stdout: 'abc123\n' }); // git rev-parse --verify origin/main
    queueExecResult({ code: 128, stderr: 'fatal: Needed a single revision' }); // branch missing

    await expect(createWorktree(defaultOpts)).resolves.toBe(expectedWtPath);

    expect(gitArgsFromExecCalls()).toEqual([
      ['worktree', 'prune'],
      ['fetch', 'origin'],
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
    queueExecResult({ code: 1, stderr: 'fatal: network down' }); // git fetch origin

    await expect(createWorktree(defaultOpts)).rejects.toThrow(
      'Failed to fetch origin before worktree creation: git fetch origin exited with code 1:\nfatal: network down'
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
    ).resolves.toBe(expectedWtPath);

    expect(gitArgsFromExecCalls()).toEqual([['worktree', 'prune']]);
    expect(gitArgsFromSpawnCalls()).toEqual([
      ['worktree', 'add', expectedWtPath, 'shipper/42-add-feature'],
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

  it('applies worktreeEnv values as-is and restores them after cleanup', async () => {
    process.env.NPM_CONFIG_CACHE = '/original-cache';
    process.env.XDG_CACHE_HOME = '/original-xdg-cache';
    process.env.UV_CACHE_DIR = '/original-uv-cache';
    getSettingsMock.mockReturnValue({
      worktreeEnv: { UV_CACHE_DIR: '.uv-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.NPM_CONFIG_CACHE).toBe(expectedNpmCachePath);
      expect(process.env.XDG_CACHE_HOME).toBe(expectedXdgCachePath);
      expect(process.env.UV_CACHE_DIR).toBe('.uv-cache');
      return Promise.resolve();
    });

    expect(process.env.NPM_CONFIG_CACHE).toBe('/original-cache');
    expect(process.env.XDG_CACHE_HOME).toBe('/original-xdg-cache');
    expect(process.env.UV_CACHE_DIR).toBe('/original-uv-cache');
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
