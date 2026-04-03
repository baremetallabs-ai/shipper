import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveMode, mockRunPrompt } = vi.hoisted(() => ({
  mockResolveMode: vi.fn((_step: string, override?: string) => override ?? 'default'),
  mockRunPrompt: vi.fn<
    (
      name: string,
      opts: {
        userInput?: string;
        mode?: string;
        agent?: string;
        model?: string;
        logFile?: string;
      }
    ) => Promise<number>
  >(),
}));

vi.mock('@dnsquared/shipper-core', () => ({
  logger: {
    error: (message: string) => {
      console.error(`[shipper] ${message}`);
    },
    log: (message: string) => {
      console.log(`[shipper] ${message}`);
    },
    warn: (message: string) => {
      console.warn(`[shipper] ${message}`);
    },
  },
  resolveMode: (step: string, override?: string) => mockResolveMode(step, override),
  runPrompt: (
    name: string,
    opts: { userInput?: string; mode?: string; agent?: string; model?: string; logFile?: string }
  ) => mockRunPrompt(name, opts),
}));

import { newCommand } from '../../src/commands/new.js';

let errorMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveMode.mockImplementation((_step: string, override?: string) => override ?? 'default');
  mockRunPrompt.mockResolvedValue(0);
  delete process.env.SHIPPER_HEADLESS;
  process.exitCode = undefined;
  errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  errorMock.mockRestore();
});

describe('newCommand', () => {
  it('passes the selected mode through to runPrompt', async () => {
    await expect(newCommand(['my', 'request'], { mode: 'headless' })).resolves.toBeUndefined();

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: 'my request',
        mode: 'headless',
      })
    );
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('uses runPrompt without a mode override when none is provided', async () => {
    await expect(newCommand(['my', 'request'])).resolves.toBeUndefined();

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: 'my request',
        mode: undefined,
      })
    );
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('forwards a log file path to runPrompt unchanged', async () => {
    await expect(
      newCommand(['my', 'request'], { logFile: '/tmp/example.jsonl', mode: 'headless' })
    ).resolves.toBeUndefined();

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: 'my request',
        mode: 'headless',
        logFile: '/tmp/example.jsonl',
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('runs interactively with no user input when no mode override is provided', async () => {
    await expect(newCommand([])).resolves.toBeUndefined();

    expect(mockResolveMode).toHaveBeenCalledWith('new', undefined);
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: undefined,
        mode: undefined,
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('runs interactively with no user input when mode is interactive', async () => {
    await expect(newCommand([], { mode: 'interactive' })).resolves.toBeUndefined();

    expect(mockResolveMode).toHaveBeenCalledWith('new', 'interactive');
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: undefined,
        mode: 'interactive',
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('throws when no request is provided in explicit headless mode', async () => {
    await expect(newCommand([], { mode: 'headless' })).rejects.toThrow(
      'Error: A request is required when running in headless mode.'
    );

    expect(mockResolveMode).toHaveBeenCalledWith('new', 'headless');
    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Usage: shipper new <request...> --mode headless'
    );
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('throws when settings resolve bare invocation to headless mode', async () => {
    mockResolveMode.mockReturnValueOnce('headless');

    await expect(newCommand([])).rejects.toThrow(
      'Error: A request is required when running in headless mode.'
    );

    expect(mockResolveMode).toHaveBeenCalledWith('new', undefined);
    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Usage: shipper new <request...> --mode headless'
    );
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('forwards codex without injecting a starter user message', async () => {
    await expect(newCommand([], { agent: 'codex' })).resolves.toBeUndefined();

    expect(mockResolveMode).toHaveBeenCalledWith('new', undefined);
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: undefined,
        agent: 'codex',
      })
    );
    expect(process.exitCode).toBe(0);
  });
});
