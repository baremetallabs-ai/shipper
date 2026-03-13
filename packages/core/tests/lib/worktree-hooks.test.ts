import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChildProcessModule = typeof import('node:child_process');
type FsPromisesModule = typeof import('node:fs/promises');
type HooksModule = typeof import('../../src/lib/hooks.js');
type SettingsModule = typeof import('../../src/lib/settings.js');

const execFileMock = vi.fn<ChildProcessModule['execFile']>();
const spawnMock = vi.fn<ChildProcessModule['spawn']>();
const accessMock = vi.fn<FsPromisesModule['access']>();
const mkdirMock = vi.fn<FsPromisesModule['mkdir']>();
const runAdvisoryHookMock = vi.fn<HooksModule['runAdvisoryHook']>();
const runWorktreeHookMock = vi.fn<HooksModule['runWorktreeHook']>();
const getSettingsMock = vi.fn<SettingsModule['getSettings']>();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<ChildProcessModule>('node:child_process');
  return {
    ...actual,
    execFile: execFileMock,
    spawn: spawnMock,
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<FsPromisesModule>('node:fs/promises');
  return {
    ...actual,
    access: accessMock,
    mkdir: mkdirMock,
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/user' };
});

vi.mock('../../src/lib/hooks.js', () => ({
  runAdvisoryHook: runAdvisoryHookMock,
  runWorktreeHook: runWorktreeHookMock,
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: getSettingsMock,
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

const { withWorktree } = await import('../../src/lib/worktree.js');

const WORKTREES_DIR = path.join('/home/user', '.shipper', 'worktrees');
const defaultOpts = {
  repoRoot: '/repos/my-repo',
  branch: 'shipper/42-add-feature',
  createBranch: true,
  issueNumber: '42',
  stage: 'implement',
};
const expectedWtPath = path.join(WORKTREES_DIR, 'my-repo--wt--shipper-42-add-feature');
const expectedNpmCachePath = path.join(expectedWtPath, '.npm-cache');

let originalNpmConfigCache: string | undefined;
let originalUvCacheDir: string | undefined;

function restoreEnvVar(key: 'NPM_CONFIG_CACHE' | 'UV_CACHE_DIR', value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

beforeEach(() => {
  originalNpmConfigCache = process.env.NPM_CONFIG_CACHE;
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
  getSettingsMock.mockReturnValue({ hooks: {} });
  mockSpawnSuccess();
});

afterEach(() => {
  restoreEnvVar('NPM_CONFIG_CACHE', originalNpmConfigCache);
  restoreEnvVar('UV_CACHE_DIR', originalUvCacheDir);
});

describe('withWorktree', () => {
  it('runs setup before the callback and teardown after it', async () => {
    const callOrder: string[] = [];
    runWorktreeHookMock.mockImplementation((event: string) => {
      callOrder.push(event);
      return Promise.resolve();
    });

    const result = await withWorktree(defaultOpts, () => {
      callOrder.push('callback');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(callOrder).toEqual(['worktree-setup', 'callback', 'worktree-teardown']);
  });

  it('passes the expected hook environment and cwd', async () => {
    await withWorktree(defaultOpts, () => undefined);

    expect(runWorktreeHookMock).toHaveBeenNthCalledWith(
      1,
      'worktree-setup',
      {
        SHIPPER_STAGE: 'implement',
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      },
      undefined,
      expectedWtPath
    );
  });

  it('runs installCommand before setup hooks', async () => {
    getSettingsMock.mockReturnValue({
      installCommand: 'npm ci',
      hooks: { worktreeSetup: 'echo setup' },
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
      expect(process.env.NPM_CONFIG_CACHE).toBe(path.join(wtPath, '.npm-cache'));
    });

    expect(process.env.NPM_CONFIG_CACHE).toBe('/original-cache');
  });

  it('applies worktreeEnv values as-is and restores them after cleanup', async () => {
    process.env.NPM_CONFIG_CACHE = '/original-cache';
    process.env.UV_CACHE_DIR = '/original-uv-cache';
    getSettingsMock.mockReturnValue({
      hooks: {},
      worktreeEnv: { UV_CACHE_DIR: '.uv-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.NPM_CONFIG_CACHE).toBe(expectedNpmCachePath);
      expect(process.env.UV_CACHE_DIR).toBe('.uv-cache');
    });

    expect(process.env.NPM_CONFIG_CACHE).toBe('/original-cache');
    expect(process.env.UV_CACHE_DIR).toBe('/original-uv-cache');
  });

  it('lets worktreeEnv override the built-in NPM_CONFIG_CACHE default', async () => {
    getSettingsMock.mockReturnValue({
      hooks: {},
      worktreeEnv: { NPM_CONFIG_CACHE: '/custom-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.NPM_CONFIG_CACHE).toBe('/custom-cache');
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
    process.env.UV_CACHE_DIR = '/before-signal-uv-cache';
    getSettingsMock.mockReturnValue({
      hooks: {},
      worktreeEnv: { UV_CACHE_DIR: '.uv-cache' },
    });

    await withWorktree(defaultOpts, () => {
      expect(process.env.NPM_CONFIG_CACHE).toBe(expectedNpmCachePath);
      expect(process.env.UV_CACHE_DIR).toBe('.uv-cache');
      sigintListener?.();
    });

    expect(
      runWorktreeHookMock.mock.calls.filter(([event]) => event === 'worktree-teardown')
    ).toHaveLength(1);
    expect(process.env.NPM_CONFIG_CACHE).toBe('/before-signal');
    expect(process.env.UV_CACHE_DIR).toBe('/before-signal-uv-cache');

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
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
