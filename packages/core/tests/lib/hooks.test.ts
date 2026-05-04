import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type HookChild = EventEmitter & {
  stderr: EventEmitter;
  stdout?: EventEmitter;
  pid?: number;
  kill: ReturnType<typeof vi.fn<(signal?: string | number) => boolean>>;
};

const spawnMock =
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => HookChild>();
const statMock = vi.fn<(path: string) => Promise<unknown>>();
const accessMock = vi.fn<(path: string, mode?: number) => Promise<void>>();
const getSettingsMock = vi.fn<() => { hookTimeoutMinutes: number }>();

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

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
}));

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

function createHookChild(opts: { pid?: number } = {}): HookChild {
  const child = new EventEmitter() as HookChild;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => true);
  if (opts.pid !== undefined) {
    child.pid = opts.pid;
  }
  return child;
}

function mockSpawnResult(opts: { code?: number; stderr?: string; error?: Error } = {}): void {
  const { code = 0, stderr = '', error } = opts;
  spawnMock.mockImplementationOnce(() => {
    const child = createHookChild();

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

async function flushHookStart(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  spawnMock.mockReset();
  statMock.mockReset();
  accessMock.mockReset();
  getSettingsMock.mockReset();
  logMock.mockClear();
  warnMock.mockClear();
  errorMock.mockClear();
  errorMock.mockImplementation(() => {});
  statMock.mockResolvedValue({});
  accessMock.mockResolvedValue(undefined);
  getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 10 });
  vi.useRealTimers();
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
    expect(logMock).toHaveBeenCalledWith('[shipper]   Test hook completed.');
  });

  it('warns on non-zero exit and includes stderr', async () => {
    mockSpawnResult({ code: 2, stderr: 'boom' });

    await runAdvisoryHook('Test', 'exit 2', {});

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Test hook exited with code 2: boom'
    );
  });

  it('throws on timeout when configured as timeout-blocking but warns on non-zero exit', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 1 });
    const child = createHookChild({ pid: 1234 });
    spawnMock.mockReturnValueOnce(child);

    const timeoutPromise = runAdvisoryHook('Install dependencies', 'npm ci', {}, '/tmp/worktree', {
      timeoutBlocking: true,
    });
    await flushHookStart();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);

    await expect(timeoutPromise).rejects.toThrow(
      'Install dependencies hook timed out after 1 minute'
    );

    vi.useRealTimers();
    mockSpawnResult({ code: 2, stderr: 'network failed' });
    await runAdvisoryHook('Install dependencies', 'npm ci', {}, '/tmp/worktree', {
      timeoutBlocking: true,
    });
    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Install dependencies hook exited with code 2: network failed'
    );
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
      `[shipper]   Warning: Found ${hookPath} but it is not executable — skipping. Run \`chmod +x ${hookPath}\` to enable.`
    );
  });

  it('rejects when the hook exits non-zero', async () => {
    mockSpawnResult({ code: 1, stderr: 'hook failed' });

    await expect(runPreHook('groom', { SHIPPER_STAGE: 'groom' })).rejects.toThrow(
      'pre-groom hook exited with code 1: hook failed'
    );
  });

  it('kills a pending hook on timeout and rejects with the configured limit', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 1 });
    const child = createHookChild({ pid: 4321 });
    spawnMock.mockReturnValueOnce(child);

    const promise = runPreHook('implement', { SHIPPER_STAGE: 'implement' });
    await flushHookStart();

    expect(spawnMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ detached: true }));
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null);
    await expect(promise).rejects.toThrow('pre-implement hook timed out after 1 minute');
  });

  it('uses the default ten minute timeout in timeout messages', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 10 });
    const child = createHookChild({ pid: 4322 });
    spawnMock.mockReturnValueOnce(child);

    const promise = runPreHook('plan', { SHIPPER_STAGE: 'plan' });
    await flushHookStart();

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);

    await expect(promise).rejects.toThrow('pre-plan hook timed out after 10 minutes');
  });

  it('does not install a timeout when hookTimeoutMinutes is 0', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 0 });
    const child = createHookChild({ pid: 4323 });
    spawnMock.mockReturnValueOnce(child);

    const promise = runPreHook('design', { SHIPPER_STAGE: 'design' });
    await flushHookStart();

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 2_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('kills a pending hook on SIGINT and removes temporary signal listeners', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 1 });
    const child = createHookChild({ pid: 4324 });
    spawnMock.mockReturnValueOnce(child);
    let sigintListener: (() => void) | undefined;
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT') {
        sigintListener = listener as () => void;
      }
      return process;
    });
    const removeListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    const promise = runPreHook('groom', { SHIPPER_STAGE: 'groom' });
    await flushHookStart();

    sigintListener?.();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null);
    await expect(promise).rejects.toThrow('pre-groom hook cancelled');
    expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('registers only one process signal listener while hooks run concurrently', async () => {
    const firstChild = createHookChild({ pid: 4325 });
    const secondChild = createHookChild({ pid: 4326 });
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const removeListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    const firstPromise = runPreHook('design', { SHIPPER_STAGE: 'design' });
    const secondPromise = runPreHook('plan', { SHIPPER_STAGE: 'plan' });
    await flushHookStart();

    expect(onSpy.mock.calls.filter(([event]) => event === 'SIGINT')).toHaveLength(1);
    expect(onSpy.mock.calls.filter(([event]) => event === 'SIGTERM')).toHaveLength(1);

    firstChild.emit('close', 0);
    await expect(firstPromise).resolves.toBeUndefined();
    expect(removeListenerSpy.mock.calls.filter(([event]) => event === 'SIGINT')).toHaveLength(0);
    expect(removeListenerSpy.mock.calls.filter(([event]) => event === 'SIGTERM')).toHaveLength(0);

    secondChild.emit('close', 0);
    await expect(secondPromise).resolves.toBeUndefined();
    expect(removeListenerSpy.mock.calls.filter(([event]) => event === 'SIGINT')).toHaveLength(1);
    expect(removeListenerSpy.mock.calls.filter(([event]) => event === 'SIGTERM')).toHaveLength(1);

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });
});

describe('runPostHook', () => {
  it('warns without throwing when the hook exits non-zero', async () => {
    mockSpawnResult({ code: 3, stderr: 'post failed' });

    await runPostHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: post-groom hook exited with code 3: post failed'
    );
  });

  it('warns without throwing when the hook times out', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 1 });
    const child = createHookChild({ pid: 5321 });
    spawnMock.mockReturnValueOnce(child);

    const promise = runPostHook('implement', { SHIPPER_STAGE: 'implement' });
    await flushHookStart();
    await vi.advanceTimersByTimeAsync(60_000);
    child.emit('close', null);

    await expect(promise).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: post-implement hook timed out after 1 minute'
    );
  });

  it('throws when a post hook is cancelled', async () => {
    vi.useFakeTimers();
    const child = createHookChild({ pid: 5322 });
    spawnMock.mockReturnValueOnce(child);
    let sigintListener: (() => void) | undefined;
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT') {
        sigintListener = listener as () => void;
      }
      return process;
    });
    const removeListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    const promise = runPostHook('implement', { SHIPPER_STAGE: 'implement' });
    await flushHookStart();

    sigintListener?.();
    await vi.advanceTimersByTimeAsync(2_000);
    child.emit('close', null);

    await expect(promise).rejects.toThrow('post-implement hook cancelled');

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
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

  it('keeps worktree setup non-zero exits advisory', async () => {
    mockSpawnResult({ code: 1, stderr: 'setup failed' });

    await runWorktreeHook('worktree-setup', env, cwd);

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Worktree setup hook exited with code 1: setup failed'
    );
  });

  it('throws when worktree setup times out', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 1 });
    const child = createHookChild({ pid: 6321 });
    spawnMock.mockReturnValueOnce(child);

    const promise = runWorktreeHook('worktree-setup', env, cwd);
    await flushHookStart();
    await vi.advanceTimersByTimeAsync(60_000);
    child.emit('close', null);

    await expect(promise).rejects.toThrow('Worktree setup hook timed out after 1 minute');
  });

  it('warns without throwing when worktree teardown times out', async () => {
    vi.useFakeTimers();
    getSettingsMock.mockReturnValue({ hookTimeoutMinutes: 1 });
    const child = createHookChild({ pid: 6322 });
    spawnMock.mockReturnValueOnce(child);

    const promise = runWorktreeHook('worktree-teardown', env, cwd);
    await flushHookStart();
    await vi.advanceTimersByTimeAsync(60_000);
    child.emit('close', null);

    await expect(promise).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Worktree teardown hook timed out after 1 minute'
    );
  });

  it('throws when worktree teardown is cancelled', async () => {
    vi.useFakeTimers();
    const child = createHookChild({ pid: 6323 });
    spawnMock.mockReturnValueOnce(child);
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const removeListenerSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    const promise = runWorktreeHook('worktree-teardown', env, cwd);
    await flushHookStart();

    const signalListener = onSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1] as
      | (() => void)
      | undefined;
    expect(signalListener).toBeDefined();
    signalListener?.();
    await vi.advanceTimersByTimeAsync(2_000);
    child.emit('close', null);

    await expect(promise).rejects.toThrow('Worktree teardown hook cancelled');

    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });
});

describe('withStageHooks', () => {
  it('runs pre hook before fn and post hook after fn, with markers wrapped around them', async () => {
    const callOrder: string[] = [];
    const performanceNowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(62_000);
    errorMock.mockImplementation((message?: unknown) => {
      callOrder.push(String(message));
    });

    spawnMock.mockImplementation((command: string) => {
      const child = createHookChild();
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

    performanceNowSpy.mockRestore();
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
    const performanceNowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(47_000);
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

    performanceNowSpy.mockRestore();
  });

  it('logs a failed stage when the pre hook rejects', async () => {
    const performanceNowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(5_000)
      .mockReturnValueOnce(6_000);
    mockSpawnResult({ code: 1, stderr: 'pre failed' });

    await expect(
      withStageHooks('plan', { issueNumber: '529' }, () => Promise.resolve())
    ).rejects.toThrow('pre-plan hook exited with code 1: pre failed');

    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:plan #529 starting'],
      ['[shipper] ✗ stage:plan #529 failed (1s)'],
    ]);

    performanceNowSpy.mockRestore();
  });

  it('preserves warning-only post hook behavior and still logs completion', async () => {
    const performanceNowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(70_000);
    mockSpawnResult();
    mockSpawnResult({ code: 3, stderr: 'post failed' });

    const result = await withStageHooks('design', { issueNumber: '77' }, () =>
      Promise.resolve('ok')
    );

    expect(result).toBe('ok');
    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: post-design hook exited with code 3: post failed'
    );
    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:design #77 starting'],
      ['[shipper] ✓ stage:design #77 complete (1m 0s)'],
    ]);

    performanceNowSpy.mockRestore();
  });

  it('omits the issue marker when the stage has no linked issue number', async () => {
    const performanceNowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(5_100);
    mockSpawnResult();
    mockSpawnResult();

    await withStageHooks('merge', {}, () => Promise.resolve());

    expect(errorMock.mock.calls).toEqual([
      ['[shipper] ▶ stage:merge starting'],
      ['[shipper] ✓ stage:merge complete (5s)'],
    ]);

    performanceNowSpy.mockRestore();
  });
});
