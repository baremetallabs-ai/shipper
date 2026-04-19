import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@dnsquared/shipper-core';
import type { RunPromptOpts } from '@dnsquared/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

describe('newCommand', () => {
  let fake: FakeCore;
  let promptCalls: Array<{ name: string; opts: RunPromptOpts }>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    delete process.env.SHIPPER_HEADLESS;
    process.exitCode = undefined;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.scriptRunPrompt((name, opts) => {
      promptCalls.push({ name, opts });
      return 0;
    });
  });

  afterEach(async () => {
    process.exitCode = undefined;
    errorSpy.mockRestore();
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('passes the selected mode through to runPrompt', async () => {
    const { newCommand } = await import('../../src/commands/new.js');

    await expect(newCommand(['my', 'request'], { mode: 'headless' })).resolves.toBeUndefined();

    expect(promptCalls).toEqual([
      {
        name: 'new',
        opts: {
          userInput: 'my request',
          mode: 'headless',
          agent: undefined,
          model: undefined,
          logFile: undefined,
        },
      },
    ]);
    expect(process.env.SHIPPER_HEADLESS).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('uses runPrompt without a mode override when none is provided', async () => {
    const { newCommand } = await import('../../src/commands/new.js');

    await expect(newCommand(['my', 'request'])).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: 'my request',
        mode: undefined,
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('forwards a log file path to runPrompt unchanged', async () => {
    const { newCommand } = await import('../../src/commands/new.js');

    await expect(
      newCommand(['my', 'request'], { logFile: '/tmp/example.jsonl', mode: 'headless' })
    ).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: 'my request',
        mode: 'headless',
        logFile: '/tmp/example.jsonl',
      })
    );
  });

  it('runs interactively with no user input when no mode override is provided', async () => {
    const { newCommand } = await import('../../src/commands/new.js');

    await expect(newCommand([])).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: undefined,
        mode: undefined,
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('runs interactively with no user input when mode is interactive', async () => {
    const { newCommand } = await import('../../src/commands/new.js');

    await expect(newCommand([], { mode: 'interactive' })).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: undefined,
        mode: 'interactive',
      })
    );
    expect(process.exitCode).toBe(0);
  });

  it('throws when no request is provided in explicit headless mode', async () => {
    const { newCommand } = await import('../../src/commands/new.js');

    await expect(newCommand([], { mode: 'headless' })).rejects.toThrow(
      'Error: A request is required when running in headless mode.'
    );

    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] Usage: shipper new <request...> --mode headless'
    );
    expect(promptCalls).toEqual([]);
  });

  it('throws when settings resolve bare invocation to headless mode', async () => {
    // resolveMode depends on settings/module state and is not covered by fake transports.
    vi.spyOn(core, 'resolveMode').mockReturnValueOnce('headless');
    const { newCommand } = await import('../../src/commands/new.js');

    await expect(newCommand([])).rejects.toThrow(
      'Error: A request is required when running in headless mode.'
    );

    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] Usage: shipper new <request...> --mode headless'
    );
    expect(promptCalls).toEqual([]);
  });

  it('forwards codex without injecting a starter user message', async () => {
    const { newCommand } = await import('../../src/commands/new.js');

    await expect(newCommand([], { agent: 'codex' })).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        userInput: undefined,
        agent: 'codex',
      })
    );
    expect(process.exitCode).toBe(0);
  });
});
