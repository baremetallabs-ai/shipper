import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunPrompt } = vi.hoisted(() => ({
  mockRunPrompt:
    vi.fn<
      (name: string, opts: { repo: string; userInput: string; mode?: string }) => Promise<number>
    >(),
}));

vi.mock('@dnsquared/shipper-core', () => ({
  runPrompt: (name: string, opts: { repo: string; userInput: string; mode?: string }) =>
    mockRunPrompt(name, opts),
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
    await expect(newCommand('owner/repo', ['my', 'request'], { mode: 'headless' })).rejects.toThrow(
      'process.exit:0'
    );

    expect(mockRunPrompt).toHaveBeenCalledWith('new', {
      repo: 'owner/repo',
      userInput: 'my request',
      mode: 'headless',
    });
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
  });

  it('uses runPrompt without a mode override when none is provided', async () => {
    await expect(newCommand('owner/repo', ['my', 'request'])).rejects.toThrow('process.exit:0');

    expect(mockRunPrompt).toHaveBeenCalledWith('new', {
      repo: 'owner/repo',
      userInput: 'my request',
      mode: undefined,
    });
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
  });

  it('exits with the existing usage error when the request is empty', async () => {
    await expect(newCommand('owner/repo', ['   '], { mode: 'interactive' })).rejects.toThrow(
      'process.exit:1'
    );

    expect(errorMock).toHaveBeenCalledWith('Error: Please provide a request for the new issue.');
    expect(errorMock).toHaveBeenCalledWith('Usage: shipper new <request>');
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });
});
