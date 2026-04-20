import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@dnsquared/shipper-core';

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (path: string) => existsSyncMock(path),
  };
});

describe('setupCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    existsSyncMock.mockReturnValue(false);
    process.exitCode = undefined;
    vi.spyOn(core, 'resolveMode').mockReturnValue('default');
    vi.spyOn(core, 'readGitStatusSnapshot').mockResolvedValue({
      repoRoot: '/repo',
      entries: [],
      byPath: new Map(),
    });
    vi.spyOn(core, 'offerSetupFinalize').mockResolvedValue({ status: 'no-changes' });
    vi.spyOn(core, 'runPrompt').mockResolvedValue(0);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('builds the blank setup starter text when .shipper is missing', async () => {
    const { setupCommand } = await import('../../src/commands/setup.js');

    await setupCommand([]);

    const promptCall = vi.mocked(core.runPrompt).mock.calls[0];
    expect(promptCall?.[0]).toBe('setup');
    expect(promptCall?.[1]?.userInput).toContain('This is a fresh setup');
  });

  it('builds the blank setup starter text when .shipper already exists', async () => {
    existsSyncMock.mockReturnValue(true);
    const { setupCommand } = await import('../../src/commands/setup.js');

    await setupCommand([]);

    const promptCall = vi.mocked(core.runPrompt).mock.calls[0];
    expect(promptCall?.[0]).toBe('setup');
    expect(promptCall?.[1]?.userInput).toContain('.shipper/ directory already exists.');
  });

  it('passes explicit words through unchanged', async () => {
    const { setupCommand } = await import('../../src/commands/setup.js');

    await setupCommand(['configure', 'the', 'repo']);

    expect(core.runPrompt).toHaveBeenCalledWith(
      'setup',
      expect.objectContaining({
        userInput: 'configure the repo',
      })
    );
  });

  it('skips finalization when the setup prompt exits non-zero', async () => {
    vi.spyOn(core, 'runPrompt').mockResolvedValueOnce(2);
    const { setupCommand } = await import('../../src/commands/setup.js');

    await setupCommand(['configure']);

    expect(core.offerSetupFinalize).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it('skips the finalize offer entirely when setup resolves to headless mode', async () => {
    vi.spyOn(core, 'resolveMode').mockReturnValueOnce('headless');
    const { setupCommand } = await import('../../src/commands/setup.js');

    await setupCommand(['configure'], { mode: 'default' });

    expect(core.runPrompt).toHaveBeenCalledWith(
      'setup',
      expect.objectContaining({ mode: 'headless' })
    );
    expect(core.offerSetupFinalize).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('forwards the resolved mode and model settings into the finalizer', async () => {
    const before = { repoRoot: '/repo', entries: [], byPath: new Map() };
    vi.spyOn(core, 'resolveMode').mockReturnValueOnce('interactive');
    vi.spyOn(core, 'readGitStatusSnapshot').mockResolvedValueOnce(before);
    const { setupCommand } = await import('../../src/commands/setup.js');

    await setupCommand(['configure'], { mode: 'interactive', agent: 'codex', model: 'gpt-5.4' });

    expect(core.resolveMode).toHaveBeenCalledWith('setup', 'interactive');
    expect(core.readGitStatusSnapshot).toHaveBeenCalledWith(process.cwd());
    const finalizeCall = vi.mocked(core.offerSetupFinalize).mock.calls[0]?.[0];
    expect(finalizeCall?.before).toBe(before);
    expect(finalizeCall?.mode).toBe('interactive');
    expect(finalizeCall?.agent).toBe('codex');
    expect(finalizeCall?.model).toBe('gpt-5.4');
    expect(typeof finalizeCall?.confirm).toBe('function');
  });

  it.each(['claude', 'codex', 'copilot'] as const)(
    'invokes the shared finalizer path for %s',
    async (agent) => {
      const { setupCommand } = await import('../../src/commands/setup.js');

      await setupCommand(['configure'], { agent });

      expect(core.runPrompt).toHaveBeenCalledWith('setup', expect.objectContaining({ agent }));
      expect(core.offerSetupFinalize).toHaveBeenCalledWith(expect.objectContaining({ agent }));
    }
  );
});
