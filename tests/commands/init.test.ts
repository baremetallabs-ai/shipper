import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

const mkdirSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const chmodSyncMock = vi.fn();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    chmodSync: (...args: unknown[]) => chmodSyncMock(...args),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../src/lib/prompts.js', () => ({
  prompts: {},
}));

vi.mock('../../src/lib/scripts.js', () => ({
  scripts: {},
}));

vi.mock('../../src/templates/readme.md', () => ({
  default: '# Test README content',
}));

vi.mock('../../src/lib/prerequisites.js', () => ({
  runPrereqChecks: () => true,
  checkGitRepo: vi.fn(),
  checkGhInstalled: vi.fn(),
  checkGhAuth: vi.fn(),
  checkGitHubRemote: vi.fn(),
}));

const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const settingsPath = path.resolve('.shipper', 'settings.json');
const gitignorePath = path.resolve('.shipper', '.gitignore');

beforeEach(() => {
  mkdirSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  readFileSyncMock.mockReset();
  existsSyncMock.mockReset();
  chmodSyncMock.mockReset();
  exitMock.mockClear();
  // Default: settings.json doesn't exist, root .gitignore doesn't exist
  existsSyncMock.mockReturnValue(false);
});

const { initCommand } = await import('../../src/commands/init.js');

describe('initCommand README', () => {
  it('writes .shipper/README.md', () => {
    initCommand();
    const readmeCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === path.resolve('.shipper', 'README.md')
    );
    expect(readmeCall).toBeDefined();
    expect(readmeCall![1]).toBe('# Test README content');
  });
});

describe('initCommand directories', () => {
  it('creates .shipper/scripts directory', () => {
    initCommand();
    const scriptsDirCall = mkdirSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === path.resolve('.shipper', 'scripts')
    );
    expect(scriptsDirCall).toBeDefined();
  });
});

describe('initCommand settings', () => {
  it('writes defaults on fresh init', () => {
    initCommand();
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written).toEqual({ prReviewWaitMinutes: 15, lockTimeoutMinutes: 30, hooks: {} });
  });

  it('preserves existing keys on re-init', () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWaitMinutes": 10}';
      return '';
    });
    initCommand();
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.prReviewWaitMinutes).toBe(10);
  });

  it('gitignore includes settings.local.json', () => {
    initCommand();
    const gitignoreCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === gitignorePath
    );
    expect(gitignoreCall).toBeDefined();
    expect(gitignoreCall![1]).toContain('settings.local.json');
    expect(gitignoreCall![1]).toContain('tmp/');
  });

  it('exits with error on malformed existing settings.json', () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{bad';
      return '';
    });
    initCommand();
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
