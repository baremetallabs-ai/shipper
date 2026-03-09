import { EventEmitter } from 'node:events';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const statMock = vi.fn();
const accessMock = vi.fn();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: (...args: unknown[]) => statMock(...args),
    access: (...args: unknown[]) => accessMock(...args),
  };
});

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

function mockSpawnResult(opts: { code?: number; stderr?: string; error?: Error } = {}): void {
  const { code = 0, stderr = '', error } = opts;
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();

    globalThis.queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }

      if (stderr) {
        child.stderr.emit('data', Buffer.from(stderr));
      }
      child.emit('close', code);
    });

    return child;
  });
}

beforeEach(() => {
  spawnMock.mockReset();
  statMock.mockReset();
  accessMock.mockReset();
  logMock.mockClear();
  warnMock.mockClear();
  statMock.mockResolvedValue({});
  accessMock.mockResolvedValue(undefined);
});

const { runAdvisoryHook, runPreHook, runPostHook, runWorktreeHook, withStageHooks } =
  await import('../../src/lib/hooks.js');

describe('runAdvisoryHook', () => {
  it('runs the command through the shell and logs success', async () => {
    mockSpawnResult();

    await runAdvisoryHook('Test', 'echo hello', { FOO: 'bar' }, '/tmp/worktree');

    expect(spawnMock).toHaveBeenCalledWith('echo hello', [], {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: expect.objectContaining({ FOO: 'bar' }),
      cwd: '/tmp/worktree',
      shell: true,
    });
    expect(logMock).toHaveBeenCalledWith('  Test hook completed.');
  });

  it('warns on non-zero exit and includes stderr', async () => {
    mockSpawnResult({ code: 2, stderr: 'boom' });

    await runAdvisoryHook('Test', 'exit 2', {});

    expect(warnMock).toHaveBeenCalledWith('  Warning: Test hook exited with code 2: boom');
  });
});

describe('runPreHook', () => {
  it('skips missing hooks', async () => {
    statMock.mockRejectedValueOnce(new Error('ENOENT'));

    await runPreHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('warns when the hook is not executable', async () => {
    const hookPath = path.resolve('.shipper', 'hooks', 'pre-groom');
    accessMock.mockRejectedValueOnce(new Error('EACCES'));

    await runPreHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(warnMock).toHaveBeenCalledWith(
      `  Warning: Found ${hookPath} but it is not executable — skipping. Run \`chmod +x ${hookPath}\` to enable.`
    );
  });

  it('rejects when the hook exits non-zero', async () => {
    mockSpawnResult({ code: 1, stderr: 'hook failed' });

    await expect(runPreHook('groom', { SHIPPER_STAGE: 'groom' })).rejects.toThrow(
      'pre-groom hook exited with code 1: hook failed'
    );
  });
});

describe('runPostHook', () => {
  it('warns without throwing when the hook exits non-zero', async () => {
    mockSpawnResult({ code: 3, stderr: 'post failed' });

    await runPostHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(warnMock).toHaveBeenCalledWith(
      '  Warning: post-groom hook exited with code 3: post failed'
    );
  });
});

describe('runWorktreeHook', () => {
  const cwd = '/tmp/worktree';
  const env = {
    SHIPPER_STAGE: 'implement',
    SHIPPER_WORKTREE_PATH: cwd,
    SHIPPER_ISSUE_NUMBER: '42',
    SHIPPER_BRANCH_NAME: 'shipper/42-branch',
  };

  it('prefers file-based hooks over settings hooks', async () => {
    mockSpawnResult();

    await runWorktreeHook('worktree-setup', env, 'echo setup', cwd);

    expect(warnMock).toHaveBeenCalledWith(
      '  Warning: Both .shipper/hooks/worktree-setup and settings-based hooks.worktreeSetup found. Using file-based hook; settings-based hook skipped.'
    );
    expect(spawnMock).toHaveBeenCalledWith(
      path.join(cwd, '.shipper', 'hooks', 'worktree-setup'),
      [],
      expect.objectContaining({ cwd, shell: undefined })
    );
  });

  it('falls back to deprecated settings hooks when no file exists', async () => {
    statMock.mockRejectedValueOnce(new Error('ENOENT'));
    mockSpawnResult();

    await runWorktreeHook('worktree-teardown', env, 'echo teardown', cwd);

    expect(warnMock).toHaveBeenCalledWith(
      '  Warning: settings-based hooks.worktreeTeardown is deprecated. Move your command to .shipper/hooks/worktree-teardown and make it executable.'
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'echo teardown',
      [],
      expect.objectContaining({ cwd, shell: true })
    );
  });
});

describe('withStageHooks', () => {
  it('runs pre hook before fn and post hook after fn', async () => {
    const callOrder: string[] = [];
    spawnMock.mockImplementation((command: string) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      globalThis.queueMicrotask(() => {
        if (String(command).includes('pre-groom')) {
          callOrder.push('pre');
        } else if (String(command).includes('post-groom')) {
          callOrder.push('post');
        }
        child.emit('close', 0);
      });
      return child;
    });

    const result = await withStageHooks('groom', { issueNumber: '10' }, async () => {
      callOrder.push('fn');
      return 42;
    });

    expect(result).toBe(42);
    expect(callOrder).toEqual(['pre', 'fn', 'post']);
  });

  it('passes stage env through to the hook process', async () => {
    mockSpawnResult();
    mockSpawnResult();

    await withStageHooks(
      'implement',
      { issueNumber: '42', branchName: 'shipper/42-feature' },
      async () => 0
    );

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('pre-implement'),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          SHIPPER_STAGE: 'implement',
          SHIPPER_ISSUE_NUMBER: '42',
          SHIPPER_BRANCH_NAME: 'shipper/42-feature',
        }),
      })
    );
  });
});
