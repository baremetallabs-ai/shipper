import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const readFileMock = vi.fn<(path: string) => string | Promise<string>>();
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: (...args: unknown[]) => {
      return readFileMock(...(args as [string]));
    },
  };
});

const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

const settingsPath = path.resolve('.shipper', 'settings.json');
const localPath = path.resolve('.shipper', 'settings.local.json');

function enoent(filepath: string): Error {
  const err = new Error(`ENOENT: no such file or directory, open '${filepath}'`) as Error & {
    code: string;
  };
  err.code = 'ENOENT';
  return err;
}

async function loadModule() {
  return await import('../../src/lib/settings.js');
}

beforeEach(() => {
  vi.resetModules();
  readFileMock.mockReset();
  warnMock.mockClear();
});

describe('loadSettings', () => {
  it('returns commands-based defaults when no files exist', async () => {
    readFileMock.mockImplementation((p: string) => {
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings()).toEqual({
      prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
      lockTimeoutMinutes: 30,
      agentTimeoutMinutes: 60,
      hookTimeoutMinutes: 10,
      commands: { default: { agent: 'claude' }, groom: { disableMcp: true } },
      merge: { requirePassingChecks: true },
    });
  });

  it('migrates legacy agents and headless into commands', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          agents: { default: 'claude', groom: 'codex' },
          headless: { new: true },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings().commands).toEqual({
      default: { agent: 'claude' },
      groom: { agent: 'codex', disableMcp: true },
      new: { mode: 'headless' },
    });
  });

  it('preserves the default agent when migrating headless-only default settings', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          headless: { default: true, new: true },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings().commands).toEqual({
      default: { agent: 'claude', mode: 'headless' },
      groom: { disableMcp: true },
      new: { mode: 'headless' },
    });
  });

  it('deep-merges commands from base and local settings', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude', model: 'opus' },
            groom: { agent: 'codex', model: 'sonnet' },
          },
        });
      }
      if (p === localPath) {
        return JSON.stringify({
          commands: {
            default: { mode: 'interactive' },
            groom: { mode: 'headless', model: 'haiku' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings().commands).toEqual({
      default: { agent: 'claude', model: 'opus', mode: 'interactive' },
      groom: { agent: 'codex', model: 'haiku', mode: 'headless', disableMcp: true },
    });
  });

  it('deep-merges disableMcp from base and local settings', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude', disableMcp: true },
            implement: { mode: 'headless', disableMcp: false },
          },
        });
      }
      if (p === localPath) {
        return JSON.stringify({
          commands: {
            implement: { disableMcp: true },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings().commands).toEqual({
      default: { agent: 'claude', disableMcp: true },
      groom: { disableMcp: true },
      implement: { mode: 'headless', disableMcp: true },
    });
  });

  it('loads worktreeEnv values exactly as configured', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          worktreeEnv: {
            UV_CACHE_DIR: '.uv-cache',
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings().worktreeEnv).toEqual({
      UV_CACHE_DIR: '.uv-cache',
    });
  });

  it('replaces worktreeEnv from local settings instead of deep-merging it', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          worktreeEnv: {
            UV_CACHE_DIR: '.uv-cache',
          },
        });
      }
      if (p === localPath) {
        return JSON.stringify({
          worktreeEnv: {
            NPM_CONFIG_CACHE: '/custom-cache',
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings().worktreeEnv).toEqual({
      NPM_CONFIG_CACHE: '/custom-cache',
    });
  });

  it('warns on unknown settings.commands keys', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            banana: { mode: 'headless' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings } = await loadModule();
    await loadSettings();

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper] Warning: Unknown command "banana" in settings.commands.'
    );
  });

  it('warns when settings-based hooks are present', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          hooks: { worktreeSetup: 'echo done' },
        });
      }
      throw enoent(p);
    });

    const { loadSettings } = await loadModule();
    await loadSettings();

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper] Warning: Unknown setting "hooks" — settings-based hooks have been removed. Use file-based hooks in .shipper/hooks/ instead.'
    );
  });

  it('ignores primitive JSON settings values without crashing', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return '123';
      }
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings()).toEqual({
      prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
      lockTimeoutMinutes: 30,
      agentTimeoutMinutes: 60,
      hookTimeoutMinutes: 10,
      commands: { default: { agent: 'claude' }, groom: { disableMcp: true } },
      merge: { requirePassingChecks: true },
    });
    expect(warnMock).not.toHaveBeenCalledWith(
      '[shipper] Warning: Unknown setting "hooks" — settings-based hooks have been removed. Use file-based hooks in .shipper/hooks/ instead.'
    );
  });

  it('throws on a non-string model value', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            implement: { model: 123 },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings } = await loadModule();
    await expect(loadSettings()).rejects.toThrow(
      'Invalid model for step "implement". Must be a string.'
    );
  });

  it('throws on a non-boolean disableMcp value', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            implement: { disableMcp: 'yes' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings } = await loadModule();
    await expect(loadSettings()).rejects.toThrow(
      'Invalid disableMcp for step "implement". Must be a boolean.'
    );
  });

  it('ignores unsafe command keys while loading settings', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            __proto__: { mode: 'headless' },
            groom: { mode: 'interactive' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings().commands).toEqual({
      default: { agent: 'claude' },
      groom: { mode: 'interactive', disableMcp: true },
    });
    expect((Object.prototype as Record<string, unknown>).mode).toBeUndefined();
  });

  it('throws on malformed JSON', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{bad json';
      throw enoent(p);
    });

    const { loadSettings } = await loadModule();
    await expect(loadSettings()).rejects.toThrow(`Malformed JSON in ${settingsPath}`);
  });

  it('throws on malformed local JSON', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath)
        return '{"prReviewWait": {"mode": "checks", "maxDurationMinutes": 20}}';
      if (p === localPath) return 'not json';
      throw enoent(p);
    });
    const { loadSettings } = await loadModule();
    await expect(loadSettings()).rejects.toThrow(`Malformed JSON in ${localPath}`);
  });
});

describe('getSettings', () => {
  it('returns defaults when loadSettings has not been called', async () => {
    const { getSettings } = await loadModule();
    expect(getSettings()).toEqual({
      prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
      lockTimeoutMinutes: 30,
      agentTimeoutMinutes: 60,
      hookTimeoutMinutes: 10,
      commands: { default: { agent: 'claude' }, groom: { disableMcp: true } },
      merge: { requirePassingChecks: true },
    });
  });
});

describe('prReviewWait migration', () => {
  it('auto-migrates legacy prReviewWaitMinutes to prReviewWait timer mode', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWaitMinutes": 10}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'timer', durationMinutes: 10 });
    expect((getSettings() as Record<string, unknown>).prReviewWaitMinutes).toBeUndefined();
  });

  it('migrates timer-mode timeoutMinutes to durationMinutes', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "timer", "timeoutMinutes": 20}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'timer', durationMinutes: 20 });
  });

  it('migrates checks-mode timeoutMinutes to maxDurationMinutes', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "checks", "timeoutMinutes": 20}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'checks', maxDurationMinutes: 20 });
  });

  it('does not migrate timeoutMinutes when prReviewWait.mode is invalid', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "typo", "timeoutMinutes": 20}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect((getSettings() as Record<string, unknown>).prReviewWait).toEqual({
      mode: 'typo',
      timeoutMinutes: 20,
    });
  });

  it('uses prReviewWait directly when present', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath)
        return '{"prReviewWait": {"mode": "checks", "maxDurationMinutes": 20}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'checks', maxDurationMinutes: 20 });
  });

  it('does not overwrite explicit prReviewWait with legacy migration', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath)
        return '{"prReviewWaitMinutes": 10, "prReviewWait": {"mode": "checks", "maxDurationMinutes": 25}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'checks', maxDurationMinutes: 25 });
  });
});

describe('lockTimeoutMinutes', () => {
  it('defaults to 30', async () => {
    readFileMock.mockImplementation((p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().lockTimeoutMinutes).toBe(30);
  });

  it('can be overridden via settings file', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"lockTimeoutMinutes": 60}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().lockTimeoutMinutes).toBe(60);
  });

  it('can be overridden via local settings file', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"lockTimeoutMinutes": 60}';
      if (p === localPath) return '{"lockTimeoutMinutes": 5}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().lockTimeoutMinutes).toBe(5);
  });
});

describe('agentTimeoutMinutes', () => {
  it('defaults to 60', async () => {
    readFileMock.mockImplementation((p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().agentTimeoutMinutes).toBe(60);
  });

  it('can be overridden via settings file', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agentTimeoutMinutes": 120}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().agentTimeoutMinutes).toBe(120);
  });

  it('can be set to 0 to disable', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agentTimeoutMinutes": 0}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().agentTimeoutMinutes).toBe(0);
  });
});

describe('hookTimeoutMinutes', () => {
  const validationMessage =
    'Invalid hookTimeoutMinutes. Must be a finite number greater than or equal to 0.';

  it('defaults to 10', async () => {
    readFileMock.mockImplementation((p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().hookTimeoutMinutes).toBe(10);
  });

  it('can be overridden via settings file', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"hookTimeoutMinutes": 5}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().hookTimeoutMinutes).toBe(5);
  });

  it('can be overridden via local settings file', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"hookTimeoutMinutes": 10}';
      if (p === localPath) return '{"hookTimeoutMinutes": 1}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().hookTimeoutMinutes).toBe(1);
  });

  it('can be set to 0 to disable', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"hookTimeoutMinutes": 0}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().hookTimeoutMinutes).toBe(0);
  });

  it('throws on negative values', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"hookTimeoutMinutes": -1}';
      throw enoent(p);
    });
    const { loadSettings } = await loadModule();
    await expect(loadSettings()).rejects.toThrow(validationMessage);
  });

  it('throws on non-finite values', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"hookTimeoutMinutes": 1e999}';
      throw enoent(p);
    });
    const { loadSettings } = await loadModule();
    await expect(loadSettings()).rejects.toThrow(validationMessage);
  });

  it('throws on string values', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"hookTimeoutMinutes": "1"}';
      throw enoent(p);
    });
    const { loadSettings } = await loadModule();
    await expect(loadSettings()).rejects.toThrow(validationMessage);
  });
});

describe('resolveAgent', () => {
  it('returns copilot from commands.default when configured', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'copilot' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveAgent } = await loadModule();
    await loadSettings();

    expect(resolveAgent('implement')).toBe('copilot');
  });

  it('returns the per-step agent override when configured', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            implement: { agent: 'copilot' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveAgent } = await loadModule();
    await loadSettings();

    expect(resolveAgent('implement')).toBe('copilot');
    expect(resolveAgent('groom')).toBe('claude');
  });

  it('throws on an invalid command agent', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            implement: { agent: 'vim' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveAgent } = await loadModule();
    await loadSettings();
    expect(() => resolveAgent('implement')).toThrow(
      'Invalid agent "vim" for step "implement". Must be "claude", "codex", or "copilot".'
    );
  });

  it('returns the override when provided', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: { default: { agent: 'claude' } },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveAgent } = await loadModule();
    await loadSettings();

    expect(resolveAgent('groom', 'copilot')).toBe('copilot');
    expect(resolveAgent('groom')).toBe('claude');
  });

  it('preserves invalid legacy default agents for later validation', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          agents: { default: 'vim' },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveAgent } = await loadModule();
    await loadSettings();

    expect(() => resolveAgent('groom')).toThrow(
      'Invalid agent "vim" for step "groom". Must be "claude", "codex", or "copilot".'
    );
  });
});

describe('resolveMode', () => {
  it('uses the CLI override unless it is default', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude', mode: 'interactive' },
            groom: { mode: 'headless' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveMode } = await loadModule();
    await loadSettings();

    expect(resolveMode('groom')).toBe('headless');
    expect(resolveMode('design')).toBe('interactive');
    expect(resolveMode('groom', 'interactive')).toBe('interactive');
    expect(resolveMode('groom', 'default')).toBe('headless');
  });

  it('throws on an invalid command mode', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            groom: { mode: 'banana' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveMode } = await loadModule();
    await loadSettings();

    expect(() => resolveMode('groom')).toThrow('Invalid mode "banana" for step "groom"');
  });

  it('flips groom default to headless when SHIPPER_EXPERIMENTAL_MCP_GROOMING is set', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({ commands: { default: { agent: 'claude' } } });
      }
      throw enoent(p);
    });

    const original = process.env.SHIPPER_EXPERIMENTAL_MCP_GROOMING;
    process.env.SHIPPER_EXPERIMENTAL_MCP_GROOMING = '1';
    try {
      const { loadSettings, resolveMode } = await loadModule();
      await loadSettings();
      expect(resolveMode('groom')).toBe('headless');
      // Other steps unchanged.
      expect(resolveMode('design')).toBe('default');
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'SHIPPER_EXPERIMENTAL_MCP_GROOMING');
      } else {
        process.env.SHIPPER_EXPERIMENTAL_MCP_GROOMING = original;
      }
    }
  });

  it('keeps groom default at "default" when the experimental flag is unset', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({ commands: { default: { agent: 'claude' } } });
      }
      throw enoent(p);
    });

    const original = process.env.SHIPPER_EXPERIMENTAL_MCP_GROOMING;
    Reflect.deleteProperty(process.env, 'SHIPPER_EXPERIMENTAL_MCP_GROOMING');
    try {
      const { loadSettings, resolveMode } = await loadModule();
      await loadSettings();
      expect(resolveMode('groom')).toBe('default');
    } finally {
      if (original !== undefined) {
        process.env.SHIPPER_EXPERIMENTAL_MCP_GROOMING = original;
      }
    }
  });
});

describe('resolveModel', () => {
  it('returns undefined when no model is set anywhere', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveModel } = await loadModule();
    await loadSettings();

    expect(resolveModel('groom')).toBeUndefined();
  });

  it('returns the per-step model when configured', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude', model: 'opus' },
            implement: { model: 'sonnet' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveModel } = await loadModule();
    await loadSettings();

    expect(resolveModel('implement')).toBe('sonnet');
  });

  it('inherits the default model when the step does not set one', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude', model: 'opus' },
            groom: { mode: 'headless' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveModel } = await loadModule();
    await loadSettings();

    expect(resolveModel('groom')).toBe('opus');
  });

  it('returns the CLI override when provided', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude', model: 'opus' },
            groom: { model: 'sonnet' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveModel } = await loadModule();
    await loadSettings();

    expect(resolveModel('groom', 'haiku')).toBe('haiku');
    expect(resolveModel('groom')).toBe('sonnet');
  });
});

describe('resolveDisableMcp', () => {
  it('defaults groom to true and other steps to false', async () => {
    readFileMock.mockImplementation((p: string) => {
      throw enoent(p);
    });

    const { loadSettings, resolveDisableMcp } = await loadModule();
    await loadSettings();

    expect(resolveDisableMcp('groom')).toBe(true);
    expect(resolveDisableMcp('implement')).toBe(false);
  });

  it('uses explicit false on groom', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            groom: { disableMcp: false },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveDisableMcp } = await loadModule();
    await loadSettings();

    expect(resolveDisableMcp('groom')).toBe(false);
  });

  it('uses local settings over base settings', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            implement: { disableMcp: false },
          },
        });
      }
      if (p === localPath) {
        return JSON.stringify({
          commands: {
            implement: { disableMcp: true },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveDisableMcp } = await loadModule();
    await loadSettings();

    expect(resolveDisableMcp('implement')).toBe(true);
  });

  it('returns the CLI override when provided', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            groom: { disableMcp: true },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveDisableMcp } = await loadModule();
    await loadSettings();

    expect(resolveDisableMcp('groom', false)).toBe(false);
    expect(resolveDisableMcp('implement', true)).toBe(true);
  });
});

describe('merge settings', () => {
  it('defaults requirePassingChecks to true', async () => {
    readFileMock.mockImplementation((p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().merge).toEqual({ requirePassingChecks: true });
  });

  it('can be overridden to false', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"merge": {"requirePassingChecks": false}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().merge.requirePassingChecks).toBe(false);
  });

  it('local overrides base merge settings', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"merge": {"requirePassingChecks": true}}';
      if (p === localPath) return '{"merge": {"requirePassingChecks": false}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().merge.requirePassingChecks).toBe(false);
  });
});
