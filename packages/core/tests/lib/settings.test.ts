import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

const readFileSyncMock = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: (...args: unknown[]) => readFileSyncMock(...args) };
});

const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
const stderrMock = vi.spyOn(console, 'error').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  vi.resetModules();
  readFileSyncMock.mockReset();
  exitMock.mockClear();
  stderrMock.mockClear();
  warnMock.mockClear();
});

function enoent(filepath: string): Error {
  const err = new Error(`ENOENT: no such file or directory, open '${filepath}'`) as Error & {
    code: string;
  };
  err.code = 'ENOENT';
  return err;
}

const settingsPath = path.resolve('.shipper', 'settings.json');
const localPath = path.resolve('.shipper', 'settings.local.json');

async function loadModule() {
  return await import('../../src/lib/settings.js');
}

describe('loadSettings', () => {
  it('returns defaults when no files exist', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings()).toEqual({
      prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
      lockTimeoutMinutes: 30,
      agents: { default: 'claude' },
      headless: {},
      hooks: {},
    });
  });

  it('loads base settings file with prReviewWait', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "timer", "timeoutMinutes": 20}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'timer', timeoutMinutes: 20 });
  });

  it('local overrides base', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "timer", "timeoutMinutes": 20}}';
      if (p === localPath) return '{"prReviewWait": {"mode": "checks", "timeoutMinutes": 5}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'checks', timeoutMinutes: 5 });
  });

  it('preserves existing keys over defaults', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "timer", "timeoutMinutes": 45}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'timer', timeoutMinutes: 45 });
  });

  it('exits with error on malformed JSON', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{bad json';
      throw enoent(p);
    });
    const { loadSettings } = await loadModule();
    loadSettings();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining(`Malformed JSON in ${settingsPath}`)
    );
  });

  it('exits with error on malformed local JSON', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "checks", "timeoutMinutes": 20}}';
      if (p === localPath) return 'not json';
      throw enoent(p);
    });
    const { loadSettings } = await loadModule();
    loadSettings();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining(`Malformed JSON in ${localPath}`)
    );
  });
});

describe('getSettings', () => {
  it('returns defaults when loadSettings has not been called', async () => {
    const { getSettings } = await loadModule();
    expect(getSettings()).toEqual({
      prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
      lockTimeoutMinutes: 30,
      agents: { default: 'claude' },
      headless: {},
      hooks: {},
    });
  });
});

describe('prReviewWait migration', () => {
  it('auto-migrates legacy prReviewWaitMinutes to prReviewWait timer mode', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWaitMinutes": 10}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'timer', timeoutMinutes: 10 });
    expect((getSettings() as Record<string, unknown>).prReviewWaitMinutes).toBeUndefined();
  });

  it('uses prReviewWait directly when present', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWait": {"mode": "checks", "timeoutMinutes": 20}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'checks', timeoutMinutes: 20 });
  });

  it('does not overwrite explicit prReviewWait with legacy migration', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath)
        return '{"prReviewWaitMinutes": 10, "prReviewWait": {"mode": "checks", "timeoutMinutes": 25}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWait).toEqual({ mode: 'checks', timeoutMinutes: 25 });
  });
});

describe('lockTimeoutMinutes', () => {
  it('defaults to 30', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().lockTimeoutMinutes).toBe(30);
  });

  it('can be overridden via settings file', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"lockTimeoutMinutes": 60}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().lockTimeoutMinutes).toBe(60);
  });

  it('can be overridden via local settings file', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"lockTimeoutMinutes": 60}';
      if (p === localPath) return '{"lockTimeoutMinutes": 5}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().lockTimeoutMinutes).toBe(5);
  });
});

describe('hooks settings', () => {
  it('loads hooks.postMerge from settings', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"hooks": {"postMerge": "echo done"}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().hooks.postMerge).toBe('echo done');
  });

  it('local hooks override base hooks', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"hooks": {"postMerge": "echo base"}}';
      if (p === localPath) return '{"hooks": {"postMerge": "echo local"}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().hooks.postMerge).toBe('echo local');
  });
});

describe('agents settings', () => {
  it('auto-migrates legacy agent string to agents.default', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agent": "codex"}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().agents.default).toBe('codex');
    expect((getSettings() as Record<string, unknown>).agent).toBeUndefined();
  });

  it('deep-merges agents from base and local', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agents": {"default": "claude", "implement": "codex"}}';
      if (p === localPath) return '{"agents": {"implement": "claude"}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().agents).toEqual({ default: 'claude', implement: 'claude' });
  });

  it('local agents do not clobber base agents.default', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agents": {"default": "claude"}}';
      if (p === localPath) return '{"agents": {"implement": "codex"}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().agents.default).toBe('claude');
    expect(getSettings().agents.implement).toBe('codex');
  });
});

describe('headless settings', () => {
  it('deep-merges headless settings from base and local', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"headless": {"new": true, "plan": false}}';
      if (p === localPath) return '{"headless": {"implement": true, "new": false}}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().headless).toEqual({ new: false, plan: false, implement: true });
  });

  it('warns on unknown headless command keys', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"headless": {"banana": true}}';
      throw enoent(p);
    });
    const { loadSettings } = await loadModule();
    loadSettings();
    expect(warnMock).toHaveBeenCalledWith(
      'Warning: Unknown command "banana" in settings.headless.'
    );
  });

  it('does not warn for known headless command keys', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"headless": {"new": true, "pr_open": false}}';
      throw enoent(p);
    });
    const { loadSettings } = await loadModule();
    loadSettings();
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('resolveAgent', () => {
  it('returns per-step override when set', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agents": {"default": "claude", "implement": "codex"}}';
      throw enoent(p);
    });
    const { loadSettings, resolveAgent } = await loadModule();
    loadSettings();
    expect(resolveAgent('implement')).toBe('codex');
  });

  it('falls back to default when step not configured', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agents": {"default": "claude"}}';
      throw enoent(p);
    });
    const { loadSettings, resolveAgent } = await loadModule();
    loadSettings();
    expect(resolveAgent('groom')).toBe('claude');
  });

  it('exits on invalid agent value', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"agents": {"default": "claude", "implement": "vim"}}';
      throw enoent(p);
    });
    const { loadSettings, resolveAgent } = await loadModule();
    loadSettings();
    resolveAgent('implement');
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('Invalid agent "vim" for step "implement"')
    );
  });
});
