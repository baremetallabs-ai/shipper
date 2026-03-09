import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
const spawnMock = vi.fn();
const accessMock = vi.fn();
const mkdirMock = vi.fn();
const runAdvisoryHookMock = vi.fn();
const runWorktreeHookMock = vi.fn();
const getSettingsMock = vi.fn();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileMock(...args),
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

beforeEach(() => {
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

describe('withWorktree', () => {
  it('runs setup before the callback and teardown after it', async () => {
    const callOrder: string[] = [];
    runWorktreeHookMock.mockImplementation(async (event: string) => {
      callOrder.push(event);
    });

    const result = await withWorktree(defaultOpts, async () => {
      callOrder.push('callback');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(callOrder).toEqual(['worktree-setup', 'callback', 'worktree-teardown']);
  });

  it('passes the expected hook environment and cwd', async () => {
    await withWorktree(defaultOpts, async () => undefined);

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
    runAdvisoryHookMock.mockImplementation(async (label: string) => {
      callOrder.push(label);
    });
    runWorktreeHookMock.mockImplementation(async (event: string) => {
      callOrder.push(event);
    });

    await withWorktree(defaultOpts, async () => {
      callOrder.push('callback');
    });

    expect(callOrder).toEqual([
      'Install dependencies',
      'worktree-setup',
      'callback',
      'worktree-teardown',
    ]);
  });

  it('runs teardown only once when a signal fires during the callback', async () => {
    let sigintListener: (() => void) | undefined;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT') {
        sigintListener = listener as () => void;
      }
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    await withWorktree(defaultOpts, async () => {
      sigintListener?.();
    });

    expect(
      runWorktreeHookMock.mock.calls.filter(([event]) => event === 'worktree-teardown')
    ).toHaveLength(1);
  });
});
