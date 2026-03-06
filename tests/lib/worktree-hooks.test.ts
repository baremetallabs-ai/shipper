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
const runWorktreeHookMock = vi.fn();
vi.mock('../../src/lib/hooks.js', () => ({
  runAdvisoryHook: (...args: unknown[]) => runAdvisoryHookMock(...args),
  runWorktreeHook: (...args: unknown[]) => runWorktreeHookMock(...args),
}));

const getSettingsMock = vi.fn();
vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => getSettingsMock(),
}));

beforeEach(() => {
  execFileSyncMock.mockReset();
  runAdvisoryHookMock.mockReset();
  runWorktreeHookMock.mockReset();
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
  stage: 'implement',
};

const expectedWtPath = path.join(WORKTREES_DIR, 'my-repo--wt--shipper-42-add-feature');

describe('withWorktree hooks', () => {
  it('runs setup hook before callback with correct env and cwd', () => {
    getSettingsMock.mockReturnValue({
      hooks: { worktreeSetup: 'npm install' },
    });

    const callOrder: string[] = [];
    runWorktreeHookMock.mockImplementation((event: string) => {
      callOrder.push(event);
    });

    withWorktree(defaultOpts, () => {
      callOrder.push('callback');
    });

    expect(runWorktreeHookMock).toHaveBeenCalledWith(
      'worktree-setup',
      {
        SHIPPER_STAGE: 'implement',
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      },
      'npm install',
      expectedWtPath
    );
    expect(callOrder.indexOf('worktree-setup')).toBeLessThan(callOrder.indexOf('callback'));
  });

  it('runs teardown hook before removeWorktree', () => {
    getSettingsMock.mockReturnValue({
      hooks: { worktreeTeardown: 'rm -rf node_modules' },
    });

    const callOrder: string[] = [];
    runWorktreeHookMock.mockImplementation((event: string) => {
      callOrder.push(event);
    });
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        callOrder.push('remove-worktree');
      }
    });

    withWorktree(defaultOpts, () => {});

    expect(runWorktreeHookMock).toHaveBeenCalledWith(
      'worktree-teardown',
      {
        SHIPPER_STAGE: 'implement',
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      },
      'rm -rf node_modules',
      expectedWtPath
    );
    expect(callOrder.indexOf('worktree-teardown')).toBeLessThan(
      callOrder.indexOf('remove-worktree')
    );
  });

  it('calls runWorktreeHook for setup and teardown even when no hooks are configured', () => {
    getSettingsMock.mockReturnValue({ hooks: {} });

    const result = withWorktree(defaultOpts, () => 'ok');

    expect(result).toBe('ok');
    expect(runAdvisoryHookMock).not.toHaveBeenCalled();
    expect(runWorktreeHookMock).toHaveBeenNthCalledWith(
      1,
      'worktree-setup',
      expect.objectContaining({
        SHIPPER_STAGE: 'implement',
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      }),
      undefined,
      expectedWtPath
    );
    expect(runWorktreeHookMock).toHaveBeenNthCalledWith(
      2,
      'worktree-teardown',
      expect.objectContaining({
        SHIPPER_STAGE: 'implement',
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      }),
      undefined,
      expectedWtPath
    );
  });

  it('runs teardown hook exactly once when signal fires during callback', () => {
    getSettingsMock.mockReturnValue({
      hooks: { worktreeTeardown: 'cleanup-cmd' },
    });

    // Capture the SIGINT listener registered by withWorktree
    let sigintListener: (() => void) | undefined;
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT') {
        sigintListener = listener as () => void;
      }
      return process;
    });
    const removeListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    withWorktree(defaultOpts, () => {
      // Simulate SIGINT arriving during the callback
      expect(sigintListener).toBeDefined();
      sigintListener!();
    });

    expect(
      runWorktreeHookMock.mock.calls.filter(([event]) => event === 'worktree-teardown')
    ).toHaveLength(1);
    expect(runWorktreeHookMock).toHaveBeenCalledWith(
      'worktree-teardown',
      expect.objectContaining({
        SHIPPER_STAGE: 'implement',
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      }),
      'cleanup-cmd',
      expectedWtPath
    );

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('defaults issueNumber and stage to empty strings when not provided', () => {
    getSettingsMock.mockReturnValue({
      hooks: { worktreeSetup: 'echo test' },
    });

    const optsWithoutIssue = {
      repoRoot: '/repos/my-repo',
      branch: 'shipper/42-add-feature',
      createBranch: true,
    };

    withWorktree(optsWithoutIssue, () => {});

    expect(runWorktreeHookMock).toHaveBeenCalledWith(
      'worktree-setup',
      expect.objectContaining({
        SHIPPER_STAGE: '',
        SHIPPER_ISSUE_NUMBER: '',
      }),
      'echo test',
      expectedWtPath
    );
  });
});

describe('installCommand in withWorktree', () => {
  it('runs installCommand before worktreeSetup hook', () => {
    getSettingsMock.mockReturnValue({
      installCommand: 'npm ci',
      hooks: { worktreeSetup: 'echo setup' },
    });

    const callOrder: string[] = [];
    runAdvisoryHookMock.mockImplementation((label: string) => {
      callOrder.push(label);
    });
    runWorktreeHookMock.mockImplementation((event: string) => {
      callOrder.push(event);
    });

    withWorktree(defaultOpts, () => {
      callOrder.push('callback');
    });

    expect(callOrder.indexOf('Install dependencies')).toBeLessThan(
      callOrder.indexOf('worktree-setup')
    );
    expect(callOrder.indexOf('worktree-setup')).toBeLessThan(callOrder.indexOf('callback'));
  });

  it('runs installCommand before runWorktreeHook setup when no worktreeSetup hook is configured', () => {
    getSettingsMock.mockReturnValue({
      installCommand: 'npm ci',
      hooks: {},
    });

    const callOrder: string[] = [];
    runAdvisoryHookMock.mockImplementation((label: string) => {
      callOrder.push(label);
    });
    runWorktreeHookMock.mockImplementation((event: string) => {
      callOrder.push(event);
    });

    withWorktree(defaultOpts, () => {
      callOrder.push('callback');
    });

    expect(callOrder.indexOf('Install dependencies')).toBeLessThan(
      callOrder.indexOf('worktree-setup')
    );
    expect(callOrder.indexOf('worktree-setup')).toBeLessThan(callOrder.indexOf('callback'));
  });

  it('passes correct arguments to runAdvisoryHook for installCommand', () => {
    getSettingsMock.mockReturnValue({
      installCommand: 'pnpm install --frozen-lockfile',
      hooks: {},
    });

    withWorktree(defaultOpts, () => {});

    expect(runAdvisoryHookMock).toHaveBeenCalledWith(
      'Install dependencies',
      'pnpm install --frozen-lockfile',
      {
        SHIPPER_STAGE: 'implement',
        SHIPPER_WORKTREE_PATH: expectedWtPath,
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-add-feature',
      },
      expectedWtPath
    );
  });

  it('does not run installCommand when not configured', () => {
    getSettingsMock.mockReturnValue({
      hooks: {},
    });

    withWorktree(defaultOpts, () => 'ok');

    expect(runAdvisoryHookMock).not.toHaveBeenCalled();
    expect(runWorktreeHookMock).toHaveBeenCalledTimes(2);
  });
});
