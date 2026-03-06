import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

const statSyncMock = vi.fn();
const accessSyncMock = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    statSync: (...args: unknown[]) => statSyncMock(...args),
    accessSync: (...args: unknown[]) => accessSyncMock(...args),
  };
});

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  statSyncMock.mockReset();
  accessSyncMock.mockReset();
  logMock.mockClear();
  warnMock.mockClear();
});

const { runAdvisoryHook, runPreHook, runPostHook, runWorktreeHook, withStageHooks } =
  await import('../../src/lib/hooks.js');

describe('runAdvisoryHook', () => {
  it('calls execSync with correct command, env, and cwd', () => {
    runAdvisoryHook('Test', 'echo hello', { FOO: 'bar' }, '/some/dir');

    expect(execSyncMock).toHaveBeenCalledWith('echo hello', {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: expect.objectContaining({ FOO: 'bar' }),
      cwd: '/some/dir',
    });
    expect(logMock).toHaveBeenCalledWith('  Test hook completed.');
  });

  it('logs warning with exit code and stderr on non-zero exit', () => {
    const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
    err.status = 1;
    err.stderr = Buffer.from('something went wrong');
    execSyncMock.mockImplementation(() => {
      throw err;
    });

    runAdvisoryHook('Test', 'exit 1', { FOO: 'bar' });

    expect(warnMock).toHaveBeenCalledWith(
      '  Warning: Test hook exited with code 1: something went wrong'
    );
  });

  it('logs warning without stderr when stderr is empty', () => {
    const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
    err.status = 2;
    err.stderr = Buffer.from('');
    execSyncMock.mockImplementation(() => {
      throw err;
    });

    runAdvisoryHook('Test', 'exit 2', { FOO: 'bar' });

    expect(warnMock).toHaveBeenCalledWith('  Warning: Test hook exited with code 2');
  });

  it('passes cwd through to execSync', () => {
    runAdvisoryHook('Test', 'echo hello', {}, '/my/cwd');

    expect(execSyncMock).toHaveBeenCalledWith(
      'echo hello',
      expect.objectContaining({ cwd: '/my/cwd' })
    );
  });

  it('does not pass cwd when not provided', () => {
    runAdvisoryHook('Test', 'echo hello', {});

    expect(execSyncMock).toHaveBeenCalledWith(
      'echo hello',
      expect.objectContaining({ cwd: undefined })
    );
  });
});

describe('runPreHook', () => {
  const preHookPath = path.resolve('.shipper', 'hooks', 'pre-groom');

  it('skips silently when hook file does not exist', () => {
    statSyncMock.mockImplementation(() => {
      const err = new Error('ENOENT') as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    });

    runPreHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
  });

  it('warns when hook file is not executable', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockImplementation(() => {
      throw new Error('EACCES');
    });

    runPreHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      `  Warning: Found ${preHookPath} but it is not executable — skipping. Run \`chmod +x ${preHookPath}\` to enable.`
    );
  });

  it('calls execFileSync with correct hook path and env', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);

    const env = {
      SHIPPER_STAGE: 'groom',
      SHIPPER_ISSUE_NUMBER: '42',
      SHIPPER_BRANCH_NAME: '',
    };
    runPreHook('groom', env);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('pre-groom'),
      [],
      expect.objectContaining({
        stdio: ['inherit', 'inherit', 'pipe'],
        env: expect.objectContaining(env),
      })
    );
    expect(logMock).toHaveBeenCalledWith('  Pre-groom hook completed.');
  });

  it('throws error with hook name and exit code on non-zero exit', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);

    const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
    err.status = 1;
    err.stderr = Buffer.from('hook failed');
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    expect(() => runPreHook('groom', { SHIPPER_STAGE: 'groom' })).toThrow(
      'pre-groom hook exited with code 1: hook failed'
    );
  });

  it('throws error without stderr when stderr is empty', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);

    const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
    err.status = 2;
    err.stderr = Buffer.from('');
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    expect(() => runPreHook('groom', { SHIPPER_STAGE: 'groom' })).toThrow(
      'pre-groom hook exited with code 2'
    );
  });
});

describe('runPostHook', () => {
  const postHookPath = path.resolve('.shipper', 'hooks', 'post-groom');

  it('skips silently when hook file does not exist', () => {
    statSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    runPostHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
  });

  it('warns when hook file is not executable', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockImplementation(() => {
      throw new Error('EACCES');
    });

    runPostHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      `  Warning: Found ${postHookPath} but it is not executable — skipping. Run \`chmod +x ${postHookPath}\` to enable.`
    );
  });

  it('calls execFileSync with correct hook path and logs on success', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);

    runPostHook('implement', { SHIPPER_STAGE: 'implement' });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('post-implement'),
      [],
      expect.objectContaining({
        stdio: ['inherit', 'inherit', 'pipe'],
      })
    );
    expect(logMock).toHaveBeenCalledWith('  Post-implement hook completed.');
  });

  it('warns but does not throw on non-zero exit', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);

    const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
    err.status = 1;
    err.stderr = Buffer.from('post hook failed');
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    // Should not throw
    runPostHook('groom', { SHIPPER_STAGE: 'groom' });

    expect(warnMock).toHaveBeenCalledWith(
      '  Warning: post-groom hook exited with code 1: post hook failed'
    );
  });
});

describe('runWorktreeHook', () => {
  const setupHookPath = path.resolve('.shipper', 'hooks', 'worktree-setup');
  const teardownHookPath = path.resolve('.shipper', 'hooks', 'worktree-teardown');
  const env = {
    SHIPPER_STAGE: 'implement',
    SHIPPER_WORKTREE_PATH: '/tmp/worktree',
    SHIPPER_ISSUE_NUMBER: '42',
    SHIPPER_BRANCH_NAME: 'shipper/42-branch',
  };

  it('runs executable file-based worktree hooks with execFileSync', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);

    runWorktreeHook('worktree-setup', env, undefined, '/tmp/worktree');

    expect(execFileSyncMock).toHaveBeenCalledWith(
      setupHookPath,
      [],
      expect.objectContaining({
        stdio: ['inherit', 'inherit', 'pipe'],
        env: expect.objectContaining(env),
        cwd: '/tmp/worktree',
      })
    );
    expect(logMock).toHaveBeenCalledWith('  Worktree setup hook completed.');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('warns and skips non-executable file-based worktree hooks', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockImplementation(() => {
      throw new Error('EACCES');
    });

    runWorktreeHook('worktree-setup', env, undefined, '/tmp/worktree');

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      `  Warning: Found ${setupHookPath} but it is not executable — skipping. Run \`chmod +x ${setupHookPath}\` to enable.`
    );
  });

  it('runs deprecated settings-based worktree hooks when no file exists', () => {
    statSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    runWorktreeHook('worktree-setup', env, 'echo setup', '/tmp/worktree');

    expect(warnMock).toHaveBeenCalledWith(
      `  Warning: settings-based hooks.worktreeSetup is deprecated. Move your command to ${setupHookPath} and make it executable.`
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'echo setup',
      expect.objectContaining({
        stdio: ['inherit', 'inherit', 'pipe'],
        env: expect.objectContaining(env),
        cwd: '/tmp/worktree',
      })
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('prefers file-based worktree hooks over deprecated settings hooks', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);

    runWorktreeHook('worktree-teardown', env, 'echo teardown', '/tmp/worktree');

    expect(warnMock).toHaveBeenCalledWith(
      `  Warning: Both ${teardownHookPath} and settings-based hooks.worktreeTeardown found. Using file-based hook; settings-based hook skipped.`
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      teardownHookPath,
      [],
      expect.objectContaining({
        env: expect.objectContaining(env),
        cwd: '/tmp/worktree',
      })
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('warns without throwing when a file-based worktree hook exits non-zero', () => {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);

    const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
    err.status = 3;
    err.stderr = Buffer.from('setup failed');
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    runWorktreeHook('worktree-setup', env, undefined, '/tmp/worktree');

    expect(warnMock).toHaveBeenCalledWith(
      '  Warning: Worktree setup hook exited with code 3: setup failed'
    );
  });

  it('no-ops when neither file-based nor settings-based worktree hooks exist', () => {
    statSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    runWorktreeHook('worktree-setup', env, undefined, '/tmp/worktree');

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
  });
});

describe('withStageHooks', () => {
  // Helper to make hooks "exist" and be "executable"
  function enableHooks() {
    statSyncMock.mockReturnValue({});
    accessSyncMock.mockReturnValue(undefined);
  }

  // Helper to make hooks "not exist"
  function disableHooks() {
    statSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  }

  it('runs pre hook before fn and post hook after fn', () => {
    enableHooks();
    const callOrder: string[] = [];

    execFileSyncMock.mockImplementation((hookPath: string) => {
      if (typeof hookPath === 'string' && hookPath.endsWith('pre-groom')) {
        callOrder.push('pre');
      } else {
        callOrder.push('post');
      }
    });

    const fn = vi.fn(() => {
      callOrder.push('fn');
      return 42;
    });

    withStageHooks('groom', { issueNumber: '10' }, fn);

    expect(callOrder).toEqual(['pre', 'fn', 'post']);
  });

  it('returns the fn return value', () => {
    disableHooks();

    const result = withStageHooks('groom', { issueNumber: '10' }, () => 'hello');

    expect(result).toBe('hello');
  });

  it('pre hook failure prevents fn from executing', () => {
    enableHooks();

    const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
    err.status = 1;
    err.stderr = Buffer.from('');
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    const fn = vi.fn(() => 42);

    expect(() => withStageHooks('groom', { issueNumber: '10' }, fn)).toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('post hook failure does not affect fn return value', () => {
    enableHooks();

    let callCount = 0;
    execFileSyncMock.mockImplementation(() => {
      callCount++;
      // First call is pre hook (success), second is post hook (fail)
      if (callCount === 2) {
        const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
        err.status = 1;
        err.stderr = Buffer.from('');
        throw err;
      }
    });

    const result = withStageHooks('groom', { issueNumber: '10' }, () => 'success');

    expect(result).toBe('success');
  });

  it('passes correct env vars from stage, issueNumber, and branchName', () => {
    enableHooks();

    withStageHooks('implement', { issueNumber: '42', branchName: 'shipper/42-feature' }, () => 0);

    expect(execFileSyncMock).toHaveBeenCalledWith(
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

  it('defaults issueNumber and branchName to empty string when not provided', () => {
    enableHooks();

    withStageHooks('groom', {}, () => 0);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          SHIPPER_STAGE: 'groom',
          SHIPPER_ISSUE_NUMBER: '',
          SHIPPER_BRANCH_NAME: '',
        }),
      })
    );
  });
});
