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
  agentPrompts: { claude: { 'test.md': '# test' } },
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
});

describe('initCommand settings', () => {
  it('writes defaults with agent on fresh init', async () => {
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written).toEqual({
      prReviewWaitMinutes: 15,
      lockTimeoutMinutes: 30,
      agent: 'claude',
      hooks: {},
    });
  });

  it('preserves existing keys on re-init', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWaitMinutes": 10, "agent": "claude"}';
      return '';
    });
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.prReviewWaitMinutes).toBe(10);
  });

  it('gitignore includes settings.local.json', async () => {
    await initCommand({ agent: 'claude' });
    const gitignoreCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === gitignorePath
    );
    expect(gitignoreCall).toBeDefined();
    expect(gitignoreCall![1]).toContain('settings.local.json');
    expect(gitignoreCall![1]).toContain('tmp/');
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

describe('initCommand agent selection', () => {
  it('--agent claude installs prompts and writes agent to settings', async () => {
    await initCommand({ agent: 'claude' });
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.agent).toBe('claude');

    const promptCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === path.resolve('.shipper', 'prompts', 'test.md')
    );
    expect(promptCall).toBeDefined();
    expect(promptCall![1]).toBe('# test');
  });

  it('--agent codex prints not yet available error and exits', async () => {
    await initCommand({ agent: 'codex' });
    expect(console.error).toHaveBeenCalledWith(
      'Codex CLI prompts are not yet available. Use Claude Code or check for updates.'
    );
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('--agent invalid prints validation error and exits', async () => {
    await initCommand({ agent: 'invalid' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid agent'));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('re-init with different agent prints switching warning', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agent": "codex"}';
      return '';
    });
    await initCommand({ agent: 'claude' });
    expect(console.log).toHaveBeenCalledWith(
      'Switching agent from codex to claude — overwriting prompt files'
    );
  });

  it('interactive prompt defaults to claude on empty input', async () => {
    questionMock.mockResolvedValueOnce('');
    await initCommand({});
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.agent).toBe('claude');
    expect(closeMock).toHaveBeenCalled();
  });

  it('interactive prompt accepts "Claude Code"', async () => {
    questionMock.mockResolvedValueOnce('Claude Code');
    await initCommand({});
    const settingsCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === settingsPath
    );
    const written = JSON.parse(settingsCall![1] as string);
    expect(written.agent).toBe('claude');
  });

  it('interactive prompt accepts "Codex CLI" and prints not available', async () => {
    questionMock.mockResolvedValueOnce('Codex CLI');
    await initCommand({});
    expect(console.error).toHaveBeenCalledWith(
      'Codex CLI prompts are not yet available. Use Claude Code or check for updates.'
    );
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
