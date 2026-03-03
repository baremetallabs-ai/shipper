import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: () => false,
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/user' };
});

const runAdvisoryHookMock = vi.fn();
vi.mock('../../src/lib/hooks.js', () => ({
  runAdvisoryHook: (...args: unknown[]) => runAdvisoryHookMock(...args),
}));

const getSettingsMock = vi.fn();
vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => getSettingsMock(),
}));

beforeEach(() => {
  execFileSyncMock.mockReset();
  runAdvisoryHookMock.mockReset();
  getSettingsMock.mockReset();
  getSettingsMock.mockReturnValue({ hooks: {} });
});

const { withWorktree } = await import('../../src/lib/worktree.js');

const WORKTREES_DIR = path.join('/home/user', '.shipper', 'worktrees');

const defaultOpts = {
  repoRoot: '/repos/my-repo',
  branch: 'shipper/42-add-feature',
  createBranch: true,
  issueNumber: '42',
};

const expectedWtPath = path.join(WORKTREES_DIR, 'my-repo--wt--shipper-42-add-feature');

describe('withWorktree hooks', () => {
  it('runs setup hook before callback with correct env and cwd', () => {
    getSettingsMock.mockReturnValue({
      hooks: { worktreeSetup: 'npm install' },
    });

    const callOrder: string[] = [];
    runAdvisoryHookMock.mockImplementation(() => {
      callOrder.push('setup-hook');
    });

    withWorktree(defaultOpts, () => {
      callOrder.push('callback');
    });

    expect(runAdvisoryHookMock).toHaveBeenCalledWith(
      'Worktree setup',
      'npm install',
      {
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      },
      expectedWtPath
    );
    expect(callOrder.indexOf('setup-hook')).toBeLessThan(callOrder.indexOf('callback'));
  });

  it('runs teardown hook before removeWorktree', () => {
    getSettingsMock.mockReturnValue({
      hooks: { worktreeTeardown: 'rm -rf node_modules' },
    });

    const callOrder: string[] = [];
    runAdvisoryHookMock.mockImplementation(() => {
      callOrder.push('teardown-hook');
    });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        callOrder.push('remove-worktree');
      }
    });

    withWorktree(defaultOpts, () => {});

    expect(runAdvisoryHookMock).toHaveBeenCalledWith(
      'Worktree teardown',
      'rm -rf node_modules',
      {
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      },
      expectedWtPath
    );
    expect(callOrder.indexOf('teardown-hook')).toBeLessThan(callOrder.indexOf('remove-worktree'));
  });

  it('does not call runAdvisoryHook when no hooks are configured', () => {
    getSettingsMock.mockReturnValue({ hooks: {} });

    const result = withWorktree(defaultOpts, () => 'ok');

    expect(result).toBe('ok');
    expect(runAdvisoryHookMock).not.toHaveBeenCalled();
  });

  it('runs teardown hook on signal cleanup', () => {
    getSettingsMock.mockReturnValue({
      hooks: { worktreeTeardown: 'cleanup-cmd' },
    });

    // Capture the SIGINT listener
    const listeners: Array<() => void> = [];
    const onSpy = vi.spyOn(process, 'on').mockImplementation((_event, listener) => {
      listeners.push(listener as () => void);
      return process;
    });
    const removeListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    withWorktree(defaultOpts, () => {});

    // The cleanup function was registered as a SIGINT listener.
    // It was also already called in the finally block.
    // Verify the teardown hook was invoked.
    expect(runAdvisoryHookMock).toHaveBeenCalledWith(
      'Worktree teardown',
      'cleanup-cmd',
      expect.objectContaining({
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      }),
      expectedWtPath
    );

    // Simulate signal by invoking the captured listener
    runAdvisoryHookMock.mockClear();
    if (listeners.length > 0) {
      listeners[0]!();
    }
    expect(runAdvisoryHookMock).toHaveBeenCalledWith(
      'Worktree teardown',
      'cleanup-cmd',
      expect.objectContaining({ SHIPPER_WORKTREE_PATH: expectedWtPath }),
      expectedWtPath
    );

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('defaults issueNumber to empty string when not provided', () => {
    getSettingsMock.mockReturnValue({
      hooks: { worktreeSetup: 'echo test' },
    });

    const optsWithoutIssue = {
      repoRoot: '/repos/my-repo',
      branch: 'shipper/42-add-feature',
      createBranch: true,
    };

    withWorktree(optsWithoutIssue, () => {});

    expect(runAdvisoryHookMock).toHaveBeenCalledWith(
      'Worktree setup',
      'echo test',
      expect.objectContaining({ SHIPPER_ISSUE_NUMBER: '' }),
      expectedWtPath
    );
  });
});
