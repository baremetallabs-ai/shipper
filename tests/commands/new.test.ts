import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../src/lib/settings.js';

const { mockRunPrompt, mockGetSettings } = vi.hoisted(() => ({
  mockRunPrompt: vi.fn(),
  mockGetSettings: vi.fn(),
}));

vi.mock('../../src/lib/prompt-runner.js', () => ({
  runPrompt: (...args: unknown[]) => mockRunPrompt(...args),
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => mockGetSettings(),
}));

import { newCommand } from '../../src/commands/new.js';

const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit:${code ?? 0}`);
}) as typeof process.exit);
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

const initialHeadlessEnv = process.env.SHIPPER_HEADLESS;

function makeSettings(headless: Record<string, boolean> = {}): Settings {
  return {
    prReviewWait: { mode: 'checks', timeoutMinutes: 15 },
    lockTimeoutMinutes: 30,
    agents: { default: 'claude' },
    headless,
    hooks: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunPrompt.mockReturnValue(0);
  mockGetSettings.mockReturnValue(makeSettings());
  if (initialHeadlessEnv === undefined) {
    delete process.env.SHIPPER_HEADLESS;
  } else {
    process.env.SHIPPER_HEADLESS = initialHeadlessEnv;
  }
});

afterAll(() => {
  if (initialHeadlessEnv === undefined) {
    delete process.env.SHIPPER_HEADLESS;
  } else {
    process.env.SHIPPER_HEADLESS = initialHeadlessEnv;
  }
  exitMock.mockRestore();
  errorMock.mockRestore();
});

describe('newCommand', () => {
  it('sets SHIPPER_HEADLESS for the prompt when the flag is enabled and clears it afterward', () => {
    let envDuringPrompt: string | undefined;
    mockRunPrompt.mockImplementation(() => {
      envDuringPrompt = process.env.SHIPPER_HEADLESS;
      return 0;
    });

    expect(() => newCommand(['my', 'pitch'], { headless: true })).toThrow('process.exit:0');

    expect(envDuringPrompt).toBe('true');
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
    expect(mockRunPrompt).toHaveBeenCalledWith('new', { userInput: 'my pitch' });
  });

  it('uses the settings headless default and restores any previous env value afterward', () => {
    let envDuringPrompt: string | undefined;
    mockGetSettings.mockReturnValue(makeSettings({ new: true }));
    process.env.SHIPPER_HEADLESS = 'preset';
    mockRunPrompt.mockImplementation(() => {
      envDuringPrompt = process.env.SHIPPER_HEADLESS;
      return 0;
    });

    expect(() => newCommand(['my', 'pitch'])).toThrow('process.exit:0');

    expect(envDuringPrompt).toBe('true');
    expect(process.env.SHIPPER_HEADLESS).toBe('preset');
    expect(mockRunPrompt).toHaveBeenCalledWith('new', { userInput: 'my pitch' });
  });

  it('does not set SHIPPER_HEADLESS when neither the flag nor settings enable it', () => {
    let envDuringPrompt: string | undefined;
    mockGetSettings.mockReturnValue(makeSettings({ new: false }));
    mockRunPrompt.mockImplementation(() => {
      envDuringPrompt = process.env.SHIPPER_HEADLESS;
      return 0;
    });

    expect(() => newCommand(['my', 'pitch'])).toThrow('process.exit:0');

    expect(envDuringPrompt).toBeUndefined();
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
    expect(mockRunPrompt).toHaveBeenCalledWith('new', { userInput: 'my pitch' });
  });

  it('exits with the existing usage error when the pitch is empty', () => {
    expect(() => newCommand(['   '], { headless: true })).toThrow('process.exit:1');

    expect(errorMock).toHaveBeenCalledWith('Error: Please provide a pitch for the new issue.');
    expect(errorMock).toHaveBeenCalledWith('Usage: shipper new <pitch>');
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });
});
