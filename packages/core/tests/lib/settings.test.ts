import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const readFileMock = vi.fn();
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: (...args: unknown[]) => readFileMock(...args) };
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
    readFileMock.mockImplementation(async (p: string) => {
      throw enoent(p);
    });

    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();

    expect(getSettings()).toEqual({
      prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
      lockTimeoutMinutes: 30,
      agentTimeoutMinutes: 60,
      commands: { default: { agent: 'claude' } },
      merge: { requirePassingChecks: true },
    });
  });

  it('migrates legacy agents and headless into commands', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
      groom: { agent: 'codex' },
      new: { mode: 'headless' },
    });
  });

  it('preserves the default agent when migrating headless-only default settings', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
      new: { mode: 'headless' },
    });
  });

  it('deep-merges commands from base and local settings', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
      groom: { agent: 'codex', model: 'haiku', mode: 'headless' },
    });
  });

  it('loads worktreeEnv values exactly as configured', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
    readFileMock.mockImplementation(async (p: string) => {
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
    readFileMock.mockImplementation(async (p: string) => {
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
      'Warning: Unknown command "banana" in settings.commands.'
    );
  });

  it('warns when settings-based hooks are present', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
      'Warning: Unknown setting "hooks" — settings-based hooks have been removed. Use file-based hooks in .shipper/hooks/ instead.'
    );
  });

  it('throws on a non-string model value', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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

  it('ignores unsafe command keys while loading settings', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
      groom: { mode: 'interactive' },
    });
    expect((Object.prototype as Record<string, unknown>).mode).toBeUndefined();
  });

  it('throws on malformed JSON', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{bad json';
      throw enoent(p);
    });

    const { loadSettings } = await loadModule();
    await expect(loadSettings()).rejects.toThrow(`Malformed JSON in ${settingsPath}`);
  });

  it('throws on malformed local JSON', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "checks", "timeoutMinutes": 20}}';
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
      prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
      lockTimeoutMinutes: 30,
      agentTimeoutMinutes: 60,
      commands: { default: { agent: 'claude' } },
      merge: { requirePassingChecks: true },
    });
  });
});

describe('prReviewWait migration', () => {
  it('auto-migrates legacy prReviewWaitMinutes to prReviewWait timer mode', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{"prReviewWaitMinutes": 10}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'timer', timeoutMinutes: 10 });
    expect((getSettings() as Record<string, unknown>).prReviewWaitMinutes).toBeUndefined();
  });

  it('uses prReviewWait directly when present', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "checks", "timeoutMinutes": 20}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'checks', timeoutMinutes: 20 });
  });

  it('does not overwrite explicit prReviewWait with legacy migration', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath)
        return '{"prReviewWaitMinutes": 10, "prReviewWait": {"mode": "checks", "timeoutMinutes": 25}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'checks', timeoutMinutes: 25 });
  });
});

describe('lockTimeoutMinutes', () => {
  it('defaults to 30', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().lockTimeoutMinutes).toBe(30);
  });

  it('can be overridden via settings file', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{"lockTimeoutMinutes": 60}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().lockTimeoutMinutes).toBe(60);
  });

  it('can be overridden via local settings file', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
    readFileMock.mockImplementation(async (p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().agentTimeoutMinutes).toBe(60);
  });

  it('can be overridden via settings file', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{"agentTimeoutMinutes": 120}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().agentTimeoutMinutes).toBe(120);
  });

  it('can be set to 0 to disable', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{"agentTimeoutMinutes": 0}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().agentTimeoutMinutes).toBe(0);
  });
});

describe('resolveAgent', () => {
  it('returns the per-step agent override when configured', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: {
            default: { agent: 'claude' },
            implement: { agent: 'codex' },
          },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveAgent } = await loadModule();
    await loadSettings();

    expect(resolveAgent('implement')).toBe('codex');
    expect(resolveAgent('groom')).toBe('claude');
  });

  it('throws on an invalid command agent', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
    expect(() => resolveAgent('implement')).toThrow('Invalid agent "vim" for step "implement"');
  });

  it('returns the override when provided', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          commands: { default: { agent: 'claude' } },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveAgent } = await loadModule();
    await loadSettings();

    expect(resolveAgent('groom', 'codex')).toBe('codex');
    expect(resolveAgent('groom')).toBe('claude');
  });

  it('preserves invalid legacy default agents for later validation', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) {
        return JSON.stringify({
          agents: { default: 'vim' },
        });
      }
      throw enoent(p);
    });

    const { loadSettings, resolveAgent } = await loadModule();
    await loadSettings();

    expect(() => resolveAgent('groom')).toThrow('Invalid agent "vim" for step "groom"');
  });
});

describe('resolveMode', () => {
  it('uses the CLI override unless it is default', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
    readFileMock.mockImplementation(async (p: string) => {
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
});

describe('resolveModel', () => {
  it('returns undefined when no model is set anywhere', async () => {
    readFileMock.mockImplementation(async (p: string) => {
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
    readFileMock.mockImplementation(async (p: string) => {
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
    readFileMock.mockImplementation(async (p: string) => {
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
    readFileMock.mockImplementation(async (p: string) => {
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

describe('merge settings', () => {
  it('defaults requirePassingChecks to true', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().merge).toEqual({ requirePassingChecks: true });
  });

  it('can be overridden to false', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{"merge": {"requirePassingChecks": false}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().merge.requirePassingChecks).toBe(false);
  });

  it('local overrides base merge settings', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === settingsPath) return '{"merge": {"requirePassingChecks": true}}';
      if (p === localPath) return '{"merge": {"requirePassingChecks": false}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    await loadSettings();
    expect(getSettings().merge.requirePassingChecks).toBe(false);
  });
});
