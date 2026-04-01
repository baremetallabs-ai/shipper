import { EventEmitter } from 'node:events';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type HookChild = EventEmitter & { stderr: EventEmitter };

const spawnMock =
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => HookChild>();
const statMock = vi.fn<(path: string) => Promise<unknown>>();
const accessMock = vi.fn<(path: string, mode?: number) => Promise<void>>();

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
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

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
  errorMock.mockClear();
  errorMock.mockImplementation(() => {});
  statMock.mockResolvedValue({});
  accessMock.mockResolvedValue(undefined);
});

const { runAdvisoryHook, runPreHook, runPostHook, runWorktreeHook, withStageHooks } =
  await import('../../src/lib/hooks.js');

describe('runAdvisoryHook', () => {
  it('runs the command through the shell and logs success', async () => {
    mockSpawnResult();

    await runAdvisoryHook('Test', 'echo hello', { FOO: 'bar' }, '/tmp/worktree');

    const spawnOptions = spawnMock.mock.calls[0]?.[2];
    expect(spawnOptions).toEqual(
      expect.objectContaining({
        stdio: ['inherit', 'inherit', 'pipe'],
        cwd: '/tmp/worktree',
        shell: true,
      })
    );
    expect(spawnOptions?.env).toEqual(expect.objectContaining({ FOO: 'bar' }));
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

  it('runs the file-based hook when present', async () => {
    mockSpawnResult();

    await runWorktreeHook('worktree-setup', env, cwd);

    expect(spawnMock).toHaveBeenCalledWith(
      path.join(cwd, '.shipper', 'hooks', 'worktree-setup'),
      [],
      expect.objectContaining({ cwd, shell: undefined })
    );
  });

  it('does nothing when no file hook exists', async () => {
    statMock.mockRejectedValueOnce(new Error('ENOENT'));

    await runWorktreeHook('worktree-teardown', env, cwd);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('withStageHooks', () => {
  it('runs pre hook before fn and post hook after fn, with markers wrapped around them', async () => {
    const callOrder: string[] = [];
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(62_000);
    errorMock.mockImplementation((message?: unknown) => {
      callOrder.push(String(message));
    });

    spawnMock.mockImplementation((command: string) => {
      const child = new EventEmitter() as HookChild;
      child.stderr = new EventEmitter();
      globalThis.queueMicrotask(() => {
        if (command.includes('pre-groom')) {
          callOrder.push('pre');
        } else if (command.includes('post-groom')) {
          callOrder.push('post');
        }
        child.emit('close', 0);
      });
      return child;
    });

    const result = await withStageHooks('groom', { issueNumber: '10' }, () => {
      callOrder.push('fn');
      return Promise.resolve(42);
    });

    expect(result).toBe(42);
    expect(callOrder).toEqual([
      '[shipper] ▶ stage:groom #10 starting',
      'pre',
      'fn',
      'post',
      '[shipper] ✓ stage:groom #10 complete (1m 1s)',
    ]);

    dateNowSpy.mockRestore();
  });

  it('passes stage env through to the hook process', async () => {
    mockSpawnResult();
    mockSpawnResult();

    await withStageHooks('implement', { issueNumber: '42', branchName: 'shipper/42-feature' }, () =>
      Promise.resolve(0)
    );

    const spawnOptions = spawnMock.mock.calls[0]?.[2];
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('pre-implement'),
      [],
      expect.any(Object)
    );
    expect(spawnOptions?.env).toEqual(
      expect.objectContaining({
        SHIPPER_STAGE: 'implement',
        SHIPPER_ISSUE_NUMBER: '42',
        SHIPPER_BRANCH_NAME: 'shipper/42-feature',
      })
    );
  });

  it('logs a failed stage and rethrows when the callback rejects', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(2_000).mockReturnValueOnce(47_000);
    mockSpawnResult();

    await expect(
      withStageHooks('implement', { issueNumber: '42' }, () =>
        Promise.reject(new Error('callback failed'))
      )
    ).rejects.toThrow('callback failed');

    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:implement #42 starting'],
      ['[shipper] ✗ stage:implement #42 failed (45s)'],
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    dateNowSpy.mockRestore();
  });

  it('logs a failed stage when the pre hook rejects', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(5_000).mockReturnValueOnce(6_000);
    mockSpawnResult({ code: 1, stderr: 'pre failed' });

    await expect(
      withStageHooks('plan', { issueNumber: '529' }, () => Promise.resolve())
    ).rejects.toThrow('pre-plan hook exited with code 1: pre failed');

    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:plan #529 starting'],
      ['[shipper] ✗ stage:plan #529 failed (1s)'],
    ]);

    dateNowSpy.mockRestore();
  });

  it('preserves warning-only post hook behavior and still logs completion', async () => {
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(70_000);
    mockSpawnResult();
    mockSpawnResult({ code: 3, stderr: 'post failed' });

    const result = await withStageHooks('design', { issueNumber: '77' }, () =>
      Promise.resolve('ok')
    );

    expect(result).toBe('ok');
    expect(warnMock).toHaveBeenCalledWith(
      '  Warning: post-design hook exited with code 3: post failed'
    );
    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:design #77 starting'],
      ['[shipper] ✓ stage:design #77 complete (1m 0s)'],
    ]);

    dateNowSpy.mockRestore();
  });
});
