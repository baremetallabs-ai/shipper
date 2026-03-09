import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunPrompt } = vi.hoisted(() => ({
  mockRunPrompt: vi.fn(),
}));

vi.mock('@dnsquared/shipper-core', () => ({
  runPrompt: (...args: unknown[]) => mockRunPrompt(...args),
}));

import { newCommand } from '../../src/commands/new.js';

const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit:${code ?? 0}`);
}) as typeof process.exit);
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  mockRunPrompt.mockResolvedValue(0);
  delete process.env.SHIPPER_HEADLESS;
});

afterAll(() => {
  exitMock.mockRestore();
  errorMock.mockRestore();
});

describe('newCommand', () => {
  it('passes the selected mode through to runPrompt', async () => {
    await expect(newCommand(['my', 'pitch'], { mode: 'headless' })).rejects.toThrow(
      'process.exit:0'
    );

    expect(mockRunPrompt).toHaveBeenCalledWith('new', {
      userInput: 'my pitch',
      mode: 'headless',
    });
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
  });

  it('uses runPrompt without a mode override when none is provided', async () => {
    await expect(newCommand(['my', 'pitch'])).rejects.toThrow('process.exit:0');

    expect(mockRunPrompt).toHaveBeenCalledWith('new', {
      userInput: 'my pitch',
      mode: undefined,
    });
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
  });

  it('exits with the existing usage error when the pitch is empty', async () => {
    await expect(newCommand(['   '], { mode: 'interactive' })).rejects.toThrow('process.exit:1');

    expect(errorMock).toHaveBeenCalledWith('Error: Please provide a pitch for the new issue.');
    expect(errorMock).toHaveBeenCalledWith('Usage: shipper new <pitch>');
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });
});
