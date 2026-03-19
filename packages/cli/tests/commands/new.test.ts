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
  resolveMode: (step: string, override?: string) => mockResolveMode(step, override),
  runPrompt: (
    name: string,
    opts: { userInput?: string; mode?: string; agent?: string; model?: string; logFile?: string }
  ) => mockRunPrompt(name, opts),
}));

import { newCommand } from '../../src/commands/new.js';

let exitMock: ReturnType<typeof vi.spyOn>;
let errorMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveMode.mockImplementation((_step: string, override?: string) => override ?? 'default');
  mockRunPrompt.mockResolvedValue(0);
  delete process.env.SHIPPER_HEADLESS;
  exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit);
  errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  exitMock.mockRestore();
  errorMock.mockRestore();
});

describe('newCommand', () => {
  it('passes the selected mode through to runPrompt', async () => {
    await expect(newCommand(['my', 'request'], { mode: 'headless' })).rejects.toThrow(
      'process.exit:0'
    );

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: 'my request',
        mode: 'headless',
      })
    );
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
  });

  it('uses runPrompt without a mode override when none is provided', async () => {
    await expect(newCommand(['my', 'request'])).rejects.toThrow('process.exit:0');

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: 'my request',
        mode: undefined,
      })
    );
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
  });

  it('forwards a log file path to runPrompt unchanged', async () => {
    await expect(
      newCommand(['my', 'request'], { logFile: '/tmp/example.jsonl', mode: 'headless' })
    ).rejects.toThrow('process.exit:0');

    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: 'my request',
        mode: 'headless',
        logFile: '/tmp/example.jsonl',
      })
    );
  });

  it('runs interactively with no user input when no mode override is provided', async () => {
    await expect(newCommand([])).rejects.toThrow('process.exit:0');

    expect(mockResolveMode).toHaveBeenCalledWith('new', undefined);
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: undefined,
        mode: undefined,
      })
    );
  });

  it('runs interactively with no user input when mode is interactive', async () => {
    await expect(newCommand([], { mode: 'interactive' })).rejects.toThrow('process.exit:0');

    expect(mockResolveMode).toHaveBeenCalledWith('new', 'interactive');
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: undefined,
        mode: 'interactive',
      })
    );
  });

  it('exits when no request is provided in explicit headless mode', async () => {
    await expect(newCommand([], { mode: 'headless' })).rejects.toThrow('process.exit:1');

    expect(mockResolveMode).toHaveBeenCalledWith('new', 'headless');
    expect(errorMock).toHaveBeenCalledWith(
      'Error: A request is required when running in headless mode.'
    );
    expect(errorMock).toHaveBeenCalledWith('Usage: shipper new <request> --mode headless');
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('exits when settings resolve bare invocation to headless mode', async () => {
    mockResolveMode.mockReturnValueOnce('headless');

    await expect(newCommand([])).rejects.toThrow('process.exit:1');

    expect(mockResolveMode).toHaveBeenCalledWith('new', undefined);
    expect(errorMock).toHaveBeenCalledWith(
      'Error: A request is required when running in headless mode.'
    );
    expect(errorMock).toHaveBeenCalledWith('Usage: shipper new <request> --mode headless');
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('returns immediately after exiting on bare headless mode when process.exit is mocked', async () => {
    exitMock.mockRestore();
    const exitReturnSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      return undefined as never;
    }) as typeof process.exit);

    await expect(newCommand([], { mode: 'headless' })).resolves.toBeUndefined();

    expect(errorMock).toHaveBeenCalledWith(
      'Error: A request is required when running in headless mode.'
    );
    expect(errorMock).toHaveBeenCalledWith('Usage: shipper new <request> --mode headless');
    expect(mockRunPrompt).not.toHaveBeenCalled();

    exitReturnSpy.mockRestore();
  });

  it('forwards codex without injecting a starter user message', async () => {
    await expect(newCommand([], { agent: 'codex' })).rejects.toThrow('process.exit:0');

    expect(mockResolveMode).toHaveBeenCalledWith('new', undefined);
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({
        userInput: undefined,
        agent: 'codex',
      })
    );
  });
});
