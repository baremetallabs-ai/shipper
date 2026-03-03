import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

const readFileSyncMock = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: (...args: unknown[]) => readFileSyncMock(...args) };
});

const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
const stderrMock = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.resetModules();
  readFileSyncMock.mockReset();
  exitMock.mockClear();
  stderrMock.mockClear();
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
    expect(getSettings()).toEqual({ prReviewWaitMinutes: 15, hooks: {} });
  });

  it('loads base settings file', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWaitMinutes": 20}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWaitMinutes).toBe(20);
  });

  it('local overrides base', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWaitMinutes": 20}';
      if (p === localPath) return '{"prReviewWaitMinutes": 5}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWaitMinutes).toBe(5);
  });

  it('preserves existing keys over defaults', async () => {
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === settingsPath) return '{"prReviewWaitMinutes": 45}';
      throw enoent(p);
    });
    const { loadSettings, getSettings } = await loadModule();
    loadSettings();
    expect(getSettings().prReviewWaitMinutes).toBe(45);
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
      if (p === settingsPath) return '{"prReviewWaitMinutes": 20}';
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
    expect(getSettings()).toEqual({ prReviewWaitMinutes: 15, hooks: {} });
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
