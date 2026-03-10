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

vi.mock('@dnsquared/shipper-core', () => ({
  gh: vi.fn(async () => ({ stdout: '', stderr: '' })),
  scripts: {},
  DEFAULTS: {
    prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
    lockTimeoutMinutes: 30,
    commands: { default: { agent: 'claude' } },
    hooks: {},
  },
  SETTING_DESCRIPTIONS: {},
  CLI_VERSION: '1.2.3',
  readmeTemplate: '# Test README content',
  runPrereqChecks: () => true,
  checkGitRepo: vi.fn(),
  checkGhInstalled: vi.fn(),
  checkGhAuth: vi.fn(),
  checkGitHubRemote: vi.fn(),
}));

const questionMock = vi.fn();
const closeMock = vi.fn();
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: questionMock, close: closeMock }),
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
  questionMock.mockReset();
  closeMock.mockReset();
  exitMock.mockClear();
  (console.log as ReturnType<typeof vi.fn>).mockClear();
  (console.error as ReturnType<typeof vi.fn>).mockClear();
  // Default: settings.json doesn't exist, root .gitignore doesn't exist
  existsSyncMock.mockReturnValue(false);
});

const { initCommand } = await import('../../src/commands/init.js');

describe('initCommand README', () => {
  it('writes .shipper/README.md', async () => {
    await initCommand({ agent: 'claude' });
    const readmeCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === path.resolve('.shipper', 'README.md')
    );
    expect(readmeCall).toBeDefined();
    expect(readmeCall![1]).toBe('# Test README content');
  });
});

describe('initCommand directories', () => {
  it('creates .shipper/scripts directory', async () => {
    await initCommand({ agent: 'claude' });
    const scriptsDirCall = mkdirSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === path.resolve('.shipper', 'scripts')
    );
    expect(scriptsDirCall).toBeDefined();
  });

  it('does not create .shipper/prompts directory', async () => {
    await initCommand({ agent: 'claude' });
    const promptDirCall = mkdirSyncMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('prompts')
    );
    expect(promptDirCall).toBeUndefined();
  });
});

describe('initCommand settings', () => {
  it('writes defaults with commands on fresh init', async () => {
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    if (!settingsCall) throw new Error('expected settings.json write');
    const written = JSON.parse(settingsCall[1] as string);
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect(written.agent).toBeUndefined();
  });

  it('preserves existing commands content on re-init', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return '{"commands": {"default": {"agent": "claude"}, "groom": {"mode": "headless"}}}';
      }
      return '';
    });
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    if (!settingsCall) throw new Error('expected settings.json write');
    const written = JSON.parse(settingsCall[1] as string);
    expect(written.commands).toEqual({
      default: { agent: 'claude' },
      groom: { mode: 'headless' },
    });
  });

  it('prefers explicit commands over legacy agent overrides during re-init', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            groom: { agent: 'codex', mode: 'interactive' },
          },
          agents: {
            default: 'codex',
            groom: 'claude',
          },
          headless: {
            groom: true,
          },
        });
      }
      return '';
    });

    await initCommand({ agent: 'claude' });

    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({
      default: { agent: 'claude' },
      groom: { agent: 'codex', mode: 'interactive' },
    });
    expect(written.agents).toBeUndefined();
    expect(written.headless).toBeUndefined();
  });

  it('ignores unsafe command keys when re-initializing settings', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return '{"commands":{"default":{"agent":"claude"},"__proto__":{"mode":"headless"}}}';
      }
      return '';
    });

    await initCommand({ agent: 'claude' });

    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect((Object.prototype as Record<string, unknown>).mode).toBeUndefined();
  });

  it('gitignore includes expected generated entries', async () => {
    await initCommand({ agent: 'claude' });
    const gitignoreCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === gitignorePath
    );
    expect(gitignoreCall).toBeDefined();
    expect(gitignoreCall![1]).toContain('settings.local.json');
    expect(gitignoreCall![1]).toContain('tmp/');
    expect(gitignoreCall![1]).toContain('README.md');
  });

  it('writes cliVersion to settings.json', async () => {
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.cliVersion).toBe('1.2.3');
  });

  it('exits with error on malformed existing settings.json', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{bad';
      return '';
    });
    await initCommand({ agent: 'claude' });
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});

const localSettingsPath = path.resolve('.shipper', 'settings.local.json');

describe('initCommand stored agent', () => {
  it('uses stored agent from settings.json (new schema) and skips prompt', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"commands": {"default": {"agent": "claude"}}}';
      throw new Error('ENOENT');
    });
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    await initCommand({});
    expect(questionMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Using agent: claude (from settings)');
  });

  it('uses stored agent from legacy agent key', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agent": "claude"}';
      throw new Error('ENOENT');
    });
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    await initCommand({});
    expect(questionMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Using agent: claude (from settings)');
  });

  it('settings.local.json overrides settings.json', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === localSettingsPath) return '{"commands": {"default": {"agent": "codex"}}}';
      if (p === settingsPath) return '{"commands": {"default": {"agent": "claude"}}}';
      throw new Error('ENOENT');
    });
    await initCommand({});
    expect(questionMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Using agent: codex (from settings)');
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({ default: { agent: 'codex' } });
  });

  it('invalid stored agent falls through to interactive prompt', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agents": {"default": "vim"}}';
      throw new Error('ENOENT');
    });
    questionMock.mockResolvedValueOnce('');
    await initCommand({});
    expect(questionMock).toHaveBeenCalled();
  });

  it('--agent flag wins over stored setting', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"commands": {"default": {"agent": "codex"}}}';
      throw new Error('ENOENT');
    });
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands.default.agent).toBe('claude');
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('from settings'));
  });
});

describe('initCommand agent selection', () => {
  it('--agent claude writes commands to settings but does not write prompt files', async () => {
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect(written.agent).toBeUndefined();

    const promptCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('prompts')
    );
    expect(promptCall).toBeUndefined();
  });

  it('--agent codex writes codex agent to settings', async () => {
    await initCommand({ agent: 'codex' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({ default: { agent: 'codex' } });
    expect(exitMock).not.toHaveBeenCalledWith(1);
  });

  it('--agent invalid prints validation error and exits', async () => {
    await initCommand({ agent: 'invalid' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid agent'));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('re-init with different agent prints switching warning', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"commands": {"default": {"agent": "codex"}}}';
      return '';
    });
    await initCommand({ agent: 'claude' });
    expect(console.log).toHaveBeenCalledWith('Switching agent from codex to claude');
  });

  it('re-init migrates legacy agent key to commands', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agent": "claude"}';
      return '';
    });
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect(written.agent).toBeUndefined();
  });

  it('interactive prompt defaults to claude on empty input', async () => {
    questionMock.mockResolvedValueOnce('');
    await initCommand({});
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect(closeMock).toHaveBeenCalled();
  });

  it('interactive prompt accepts "Claude Code"', async () => {
    questionMock.mockResolvedValueOnce('Claude Code');
    await initCommand({});
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
  });

  it('interactive prompt accepts "Codex CLI" and writes codex agent to settings', async () => {
    questionMock.mockResolvedValueOnce('Codex CLI');
    await initCommand({});
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.commands).toEqual({ default: { agent: 'codex' } });
    expect(exitMock).not.toHaveBeenCalledWith(1);
  });
});
