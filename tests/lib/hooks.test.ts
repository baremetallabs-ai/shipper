import { describe, it, expect, vi, beforeEach } from 'vitest';

const execSyncMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  execSyncMock.mockReset();
  logMock.mockClear();
  warnMock.mockClear();
});

const { runAdvisoryHook } = await import('../../src/lib/hooks.js');

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
