import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toError, toErrorMessage } from '../../../core/src/lib/errors.js';
import { isPlainObject } from '../../../core/src/lib/type-guards.js';

const { mockGh, mockExecFileAsync, mockRunPrereqChecks } = vi.hoisted(() => ({
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  mockExecFileAsync:
    vi.fn<
      (
        cmd: string,
        args: string[],
        opts?: Record<string, unknown>
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
  mockRunPrereqChecks: vi.fn<(checks: unknown[]) => boolean>(),
}));

const { canonicalLabels } = vi.hoisted(() => ({
  canonicalLabels: [
    { name: 'shipper:new', color: 'C2E0C6', description: 'New issue from shipper' },
    { name: 'shipper:groomed', color: 'BFD4F2', description: 'Product-groomed' },
    { name: 'shipper:designed', color: 'D4C5F9', description: 'Design-reviewed' },
    { name: 'shipper:planned', color: 'FEF2C0', description: 'Implementation planned' },
    { name: 'shipper:implemented', color: 'FBCA04', description: 'Implementation complete' },
    { name: 'shipper:pr-open', color: 'F9D0C4', description: 'PR opened' },
    {
      name: 'shipper:pr-reviewed',
      color: 'E6B8AF',
      description: 'PR reviewed, pending remediation',
    },
    { name: 'shipper:ready', color: '0E8A16', description: 'Ready for final review and merge' },
    {
      name: 'shipper:blocked',
      color: 'E11D48',
      description: 'Blocked by a dependency — run shipper unblock',
    },
    {
      name: 'shipper:locked',
      color: 'D93F0B',
      description: 'Locked by an active shipper instance',
    },
    {
      name: 'shipper:failed',
      color: '6A0DAD',
      description: 'Failed after exhausting transition cap — requires manual intervention',
    },
    {
      name: 'shipper:priority-high',
      color: 'D93F0B',
      description: 'High-priority issue',
    },
    {
      name: 'shipper:priority-low',
      color: '0E8A16',
      description: 'Low-priority issue',
    },
  ],
}));

const mkdirSyncMock =
  vi.fn<(path: string, options?: import('node:fs').MakeDirectoryOptions) => void>();
const writeFileSyncMock = vi.fn<(target: string | number, data: string | Buffer) => void>();
const readFileSyncMock = vi.fn<(path: string, encoding?: string) => string>();
const existsSyncMock = vi.fn<(path: string) => boolean>();
const chmodSyncMock = vi.fn<(path: string, mode: number) => void>();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: (path: string, options?: import('node:fs').MakeDirectoryOptions) => {
      mkdirSyncMock(path, options);
    },
    writeFileSync: (target: string | number, data: string | Buffer) => {
      writeFileSyncMock(target, data);
    },
    readFileSync: (path: string, encoding?: string) => readFileSyncMock(path, encoding),
    existsSync: (path: string) => existsSyncMock(path),
    chmodSync: (path: string, mode: number) => {
      chmodSyncMock(path, mode);
    },
  };
});

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execFile = Object.assign(
    (...args: unknown[]) => {
      void mockExecFileAsync(...(args as Parameters<typeof mockExecFileAsync>));
    },
    {
      [promisify.custom]: (...args: unknown[]) =>
        mockExecFileAsync(...(args as Parameters<typeof mockExecFileAsync>)),
    }
  );
  return { ...actual, execFile };
});

vi.mock('@dnsquared/shipper-core', () => ({
  logger: {
    log: (message: string) => {
      console.log(`[shipper] ${message}`);
    },
    warn: (message: string) => {
      console.warn(`[shipper] ${message}`);
    },
    error: (message: string) => {
      console.error(`[shipper] ${message}`);
    },
  },
  toError,
  toErrorMessage,
  isPlainObject,
  gh: (args: string[]) => mockGh(args),
  scripts: {},
  LABELS: canonicalLabels,
  DEFAULTS: {
    prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
    lockTimeoutMinutes: 30,
    commands: { default: { agent: 'claude' } },
  },
  SETTING_DESCRIPTIONS: {},
  CLI_VERSION: '1.2.3',
  readmeTemplate: '# Test README content',
  runPrereqChecks: (checks: unknown[]) => mockRunPrereqChecks(checks),
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
const promptsDirPath = path.resolve('.shipper', 'prompts');
const inputDirPath = path.resolve('.shipper', 'input');
const outputDirPath = path.resolve('.shipper', 'output');
const inputGitkeepPath = path.resolve(inputDirPath, '.gitkeep');
const outputGitkeepPath = path.resolve(outputDirPath, '.gitkeep');
const expectedLabels = canonicalLabels;

type JsonObject = Record<string, unknown>;
type WriteFileCall = [target: string | number, data: string | Buffer];

function findWriteCall(targetPath: string): WriteFileCall | undefined {
  return writeFileSyncMock.mock.calls.find(([target]) => target === targetPath);
}

function parseJsonObject(value: string | Buffer): JsonObject {
  const parsed: unknown = JSON.parse(value.toString());
  if (!isPlainObject(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed;
}

function parseWrittenSettings(): JsonObject {
  const settingsCall = findWriteCall(settingsPath);
  if (!settingsCall) {
    throw new Error('expected settings.json write');
  }

  return parseJsonObject(settingsCall[1]);
}

function getCommands(settings: JsonObject): JsonObject {
  if (!isPlainObject(settings.commands)) {
    throw new Error('Expected commands object');
  }
  return settings.commands;
}

function getCommandConfig(settings: JsonObject, key: string): JsonObject {
  const commands = getCommands(settings);
  if (!isPlainObject(commands[key])) {
    throw new Error(`Expected commands.${key} object`);
  }
  return commands[key];
}

beforeEach(() => {
  mkdirSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  readFileSyncMock.mockReset();
  existsSyncMock.mockReset();
  chmodSyncMock.mockReset();
  mockGh.mockReset();
  mockGh.mockResolvedValue({ stdout: '', stderr: '' });
  mockExecFileAsync.mockReset();
  mockRunPrereqChecks.mockReset();
  mockRunPrereqChecks.mockReturnValue(true);
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
      return Promise.resolve({ stdout: 'main\n', stderr: '' });
    }
    if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  });
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
    expect(readmeCall?.[1]).toBe('# Test README content');
  });
});

describe('initCommand label sync', () => {
  it('syncs each canonical label with --force and reports the synced count', async () => {
    await initCommand({ agent: 'claude' });

    const labelCalls = mockGh.mock.calls.filter((call) => call[0][0] === 'label');
    expect(labelCalls).toHaveLength(expectedLabels.length);
    expect(labelCalls).toEqual(
      expectedLabels.map((label) => [
        [
          'label',
          'create',
          label.name,
          '--force',
          '--color',
          label.color,
          '--description',
          label.description,
        ],
      ])
    );
    expect(console.log).toHaveBeenCalledWith(`[shipper] Synced ${expectedLabels.length} labels`);
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Created \d+ new label\(s\)$/)
    );
    expect(console.log).not.toHaveBeenCalledWith('All labels already exist');
  });

  it('propagates gh failures during label sync', async () => {
    mockGh.mockRejectedValueOnce(new Error('label sync failed'));

    await expect(initCommand({ agent: 'claude' })).rejects.toThrow('label sync failed');
    expect(console.log).not.toHaveBeenCalledWith(
      `[shipper] Synced ${expectedLabels.length} labels`
    );
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

  it('creates .shipper/input and .shipper/output directories', async () => {
    await initCommand({ agent: 'claude' });
    const inputDirCall = mkdirSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === inputDirPath
    );
    const outputDirCall = mkdirSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === outputDirPath
    );
    expect(inputDirCall).toBeDefined();
    expect(outputDirCall).toBeDefined();
  });

  it('does not create .shipper/prompts directory', async () => {
    await initCommand({ agent: 'claude' });
    const promptDirCall = mkdirSyncMock.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        (call[0] === promptsDirPath || call[0].startsWith(`${promptsDirPath}${path.sep}`))
    );
    expect(promptDirCall).toBeUndefined();
  });
});

describe('initCommand settings', () => {
  it('writes defaults with commands on fresh init', async () => {
    await initCommand({ agent: 'claude' });
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect(written.agent).toBeUndefined();
    expect(written.hooks).toBeUndefined();
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
    const written = parseWrittenSettings();
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

    const written = parseWrittenSettings();
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

    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect((Object.prototype as Record<string, unknown>).mode).toBeUndefined();
  });

  it('strips deprecated hooks from existing settings on re-init', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return '{"commands":{"default":{"agent":"claude"}},"hooks":{"worktreeSetup":"echo setup"}}';
      }
      return '';
    });

    await initCommand({ agent: 'claude' });

    const written = parseWrittenSettings();
    expect(written.hooks).toBeUndefined();
  });

  it('gitignore includes expected generated entries', async () => {
    await initCommand({ agent: 'claude' });
    const gitignoreCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) => call[0] === gitignorePath
    );
    expect(gitignoreCall).toBeDefined();
    expect(gitignoreCall?.[1]).toBe(
      'tmp/\nsettings.local.json\nREADME.md\ninput/*\n!input/.gitkeep\noutput/*\n!output/.gitkeep\n'
    );
  });

  it('writes .gitkeep files to input and output directories', async () => {
    await initCommand({ agent: 'claude' });
    expect(findWriteCall(inputGitkeepPath)?.[1]).toBe('');
    expect(findWriteCall(outputGitkeepPath)?.[1]).toBe('');
  });

  it('writes cliVersion to settings.json', async () => {
    await initCommand({ agent: 'claude' });
    const written = parseWrittenSettings();
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
    expect(findWriteCall(settingsPath)).toBeUndefined();
    expect(findWriteCall(path.resolve('.shipper', 'README.md'))).toBeUndefined();
    expect(mockGh).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', ['add', '--', '.shipper/']);
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
    expect(console.log).toHaveBeenCalledWith('[shipper] Using agent: claude (from settings)');
  });

  it('uses stored agent from legacy agent key', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agent": "claude"}';
      throw new Error('ENOENT');
    });
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    await initCommand({});
    expect(questionMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('[shipper] Using agent: claude (from settings)');
  });

  it('settings.local.json overrides settings.json', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === localSettingsPath) return '{"commands": {"default": {"agent": "copilot"}}}';
      if (p === settingsPath) return '{"commands": {"default": {"agent": "claude"}}}';
      throw new Error('ENOENT');
    });
    await initCommand({});
    expect(questionMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('[shipper] Using agent: copilot (from settings)');
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'copilot' } });
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
    const written = parseWrittenSettings();
    expect(getCommandConfig(written, 'default').agent).toBe('claude');
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('from settings'));
  });
});

describe('initCommand agent selection', () => {
  it('--agent claude writes commands to settings but does not write prompt files', async () => {
    await initCommand({ agent: 'claude' });
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect(written.agent).toBeUndefined();

    const promptCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        (call[0] === promptsDirPath || call[0].startsWith(`${promptsDirPath}${path.sep}`))
    );
    expect(promptCall).toBeUndefined();
  });

  it('--agent codex writes codex agent to settings', async () => {
    await initCommand({ agent: 'codex' });
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'codex' } });
    expect(exitMock).not.toHaveBeenCalledWith(1);
  });

  it('--agent copilot writes copilot agent to settings', async () => {
    await initCommand({ agent: 'copilot' });
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'copilot' } });
    expect(exitMock).not.toHaveBeenCalledWith(1);
  });

  it('--agent invalid prints validation error and exits', async () => {
    await initCommand({ agent: 'invalid' });
    expect(console.error).toHaveBeenCalledWith(
      '[shipper] Error: Invalid agent "invalid". Must be one of: claude, codex, copilot'
    );
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('re-init with different agent prints switching warning', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"commands": {"default": {"agent": "codex"}}}';
      return '';
    });
    await initCommand({ agent: 'claude' });
    expect(console.log).toHaveBeenCalledWith('[shipper] Switching agent from codex to claude');
  });

  it('re-init migrates legacy agent key to commands', async () => {
    existsSyncMock.mockImplementation((p: string) => p === settingsPath);
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agent": "claude"}';
      return '';
    });
    await initCommand({ agent: 'claude' });
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect(written.agent).toBeUndefined();
  });

  it('interactive prompt defaults to claude on empty input', async () => {
    questionMock.mockResolvedValueOnce('');
    await initCommand({});
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
    expect(closeMock).toHaveBeenCalled();
  });

  it('interactive prompt accepts "Claude Code"', async () => {
    questionMock.mockResolvedValueOnce('Claude Code');
    await initCommand({});
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'claude' } });
  });

  it('interactive prompt accepts "Codex CLI" and writes codex agent to settings', async () => {
    questionMock.mockResolvedValueOnce('Codex CLI');
    await initCommand({});
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'codex' } });
    expect(exitMock).not.toHaveBeenCalledWith(1);
  });

  it('interactive prompt accepts "Copilot CLI" and writes copilot agent to settings', async () => {
    questionMock.mockResolvedValueOnce('Copilot CLI');
    await initCommand({});
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'copilot' } });
    expect(exitMock).not.toHaveBeenCalledWith(1);
  });

  it('interactive prompt accepts "github copilot" alias', async () => {
    questionMock.mockResolvedValueOnce('github copilot');
    await initCommand({});
    const written = parseWrittenSettings();
    expect(written.commands).toEqual({ default: { agent: 'copilot' } });
  });
});

describe('initCommand commit and push', () => {
  it('stops immediately when prerequisite checks fail', async () => {
    mockRunPrereqChecks.mockReturnValue(false);

    await initCommand({ agent: 'claude' });

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(mockGh).not.toHaveBeenCalled();
  });

  it('writes files and syncs labels without git add, commit, or push by default', async () => {
    await initCommand({ agent: 'claude' });

    const labelCalls = mockGh.mock.calls.filter((call) => call[0][0] === 'label');
    expect(labelCalls).toHaveLength(expectedLabels.length);
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'ls-files',
      '--',
      '.shipper/output/',
      '.shipper/input/',
    ]);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', ['add', '--', '.shipper/']);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['commit']));
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    });
    expect(mockGh.mock.calls.some((call) => call[0][0] === 'repo' && call[0][1] === 'view')).toBe(
      false
    );
    expect(console.log).toHaveBeenCalledWith(
      "[shipper] Tip: run 'git add .shipper/ && git commit' to commit your changes, then push to your default branch."
    );
  });

  it('untracks tracked output and input files before the autocommit and push flow', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'ls-files') {
        return Promise.resolve({
          stdout:
            '.shipper/output/result.json\r\n.shipper/input/example.txt\r\n.shipper/output/.gitkeep\r\n',
          stderr: '',
        });
      }
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        return Promise.reject(new Error('exit code 1'));
      }
      if (
        cmd === 'git' &&
        args[0] === 'diff' &&
        args[1] === '--cached' &&
        args[2] === '--name-only'
      ) {
        return Promise.resolve({
          stdout: '.shipper/output/result.json\0.shipper/input/example.txt\0',
          stderr: '',
        });
      }
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: 'feature/init\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude', autocommit: true, push: true });

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'rm',
      '--cached',
      '--',
      '.shipper/output/result.json',
      '.shipper/input/example.txt',
    ]);
    expect(console.log).toHaveBeenCalledWith('[shipper] Untracked: .shipper/output/result.json');
    expect(console.log).toHaveBeenCalledWith('[shipper] Untracked: .shipper/input/example.txt');
    expect(console.log).toHaveBeenCalledWith(
      '[shipper] These files were tracked by git but should be gitignored. Commit the changes to complete the fix.'
    );
    expect(
      (console.log as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => typeof message === 'string' && message.endsWith('.gitkeep')
      )
    ).toHaveLength(0);

    const rmCallOrder = mockExecFileAsync.mock.calls.findIndex(
      ([cmd, args]) => cmd === 'git' && args[0] === 'rm'
    );
    const addCallOrder = mockExecFileAsync.mock.calls.findIndex(
      ([cmd, args]) => cmd === 'git' && args[0] === 'add'
    );
    expect(rmCallOrder).toBeGreaterThanOrEqual(0);
    expect(addCallOrder).toBeGreaterThan(rmCallOrder);

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['add', '--', '.shipper/']);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--cached', '--name-only', '-z'],
      {
        encoding: 'utf-8',
      }
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: initialize shipper',
    ]);
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['push', 'origin', 'feature/init']);
  });

  it('does not log or untrack anything when no tracked output or input files exist', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'ls-files') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude' });

    expect(mockExecFileAsync).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['rm', '--cached'])
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Untracked:'));
    expect(console.log).not.toHaveBeenCalledWith(
      'These files were tracked by git but should be gitignored. Commit the changes to complete the fix.'
    );
  });

  it('continues init when tracked-file cleanup cannot query git', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'ls-files') {
        return Promise.reject(new Error('git failed'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude' });

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'ls-files',
      '--',
      '.shipper/output/',
      '.shipper/input/',
    ]);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['rm', '--cached'])
    );
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', ['add', '--', '.shipper/']);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Untracked:'));
    expect(console.log).toHaveBeenCalledWith(
      "[shipper] Tip: run 'git add .shipper/ && git commit' to commit your changes, then push to your default branch."
    );
  });

  it('warns and keeps the normal commit path when git rm --cached fails', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'ls-files') {
        return Promise.resolve({ stdout: '.shipper/output/result.json\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'rm') {
        const err = Object.assign(new Error('rm failed'), {
          stderr: 'git rm failed',
        });
        return Promise.reject(err);
      }
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        return Promise.reject(new Error('exit code 1'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude', autocommit: true });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Warning: Failed to untrack tracked files under .shipper/output/ and .shipper/input.'
      )
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: initialize shipper',
      '--',
      '.shipper/',
    ]);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: initialize shipper',
    ]);
  });

  it('stages and commits without pushing when autocommit is enabled', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        return Promise.reject(new Error('exit code 1'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude', autocommit: true });

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['add', '--', '.shipper/']);
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: initialize shipper',
      '--',
      '.shipper/',
    ]);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    });
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
    expect(console.log).toHaveBeenCalledWith('[shipper] Committed .shipper/ files.');
  });

  it('stages, commits, and pushes the current branch when autocommit and push are enabled', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        return Promise.reject(new Error('exit code 1'));
      }
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: 'feature/init\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude', autocommit: true, push: true });

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: initialize shipper',
      '--',
      '.shipper/',
    ]);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['config', 'branch.feature/init.remote'],
      {
        encoding: 'utf-8',
      }
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['push', 'origin', 'feature/init']);
    expect(console.log).toHaveBeenCalledWith(
      '[shipper] Committed and pushed .shipper/ files to feature/init'
    );
  });

  it('uses the configured remote instead of origin on the push path', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        return Promise.reject(new Error('exit code 1'));
      }
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: 'feature/init\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'config' && args[1] === 'branch.feature/init.remote') {
        return Promise.resolve({ stdout: 'upstream\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude', autocommit: true, push: true });

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['push', 'upstream', 'feature/init']);
  });

  it('errors when push is requested without autocommit', async () => {
    await initCommand({ agent: 'claude', push: true });

    expect(console.error).toHaveBeenCalledWith('[shipper] Error: --push requires --autocommit.');
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('skips commit and push when .shipper/ files are unchanged under autocommit', async () => {
    await initCommand({ agent: 'claude', autocommit: true });

    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['add', '--', '.shipper/']);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['commit']));
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
    expect(console.log).toHaveBeenCalledWith(
      '[shipper] .shipper/ files are unchanged — nothing to commit.'
    );
  });

  it('errors and exits on detached HEAD only for the push path', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        return Promise.reject(new Error('exit code 1'));
      }
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: '\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude', autocommit: true, push: true });

    expect(console.error).toHaveBeenCalledWith(
      '[shipper] Error: Failed to push from detached HEAD.\nCheck out a branch and retry with --push.'
    );
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['commit']));
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
  });

  it('reports error with stderr when push fails', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        return Promise.reject(new Error('exit code 1'));
      }
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: 'feature/init\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'push') {
        const err = Object.assign(new Error('push failed'), {
          stderr: 'remote: protected branch',
        });
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude', autocommit: true, push: true });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to push to feature/init')
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('protected branch'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('branch protection rules'));
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: initialize shipper',
      '--',
      '.shipper/',
    ]);
  });

  it('does not roll back labels when push fails', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
        return Promise.reject(new Error('exit code 1'));
      }
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ stdout: 'feature/init\n', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'push') {
        return Promise.reject(new Error('push failed'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await initCommand({ agent: 'claude', autocommit: true, push: true });

    const labelCalls = mockGh.mock.calls.filter((call) => call[0][0] === 'label');
    expect(labelCalls).toHaveLength(expectedLabels.length);
  });
});
