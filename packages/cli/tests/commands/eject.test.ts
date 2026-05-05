import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@baremetallabs-ai/shipper-core';

const { existsSyncMock, mkdirSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(),
  mkdirSyncMock: vi.fn<(path: string, options?: import('node:fs').MakeDirectoryOptions) => void>(),
  writeFileSyncMock: vi.fn<(path: string, data: string) => void>(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (path: string) => existsSyncMock(path),
    mkdirSync: (path: string, options?: import('node:fs').MakeDirectoryOptions) => {
      mkdirSyncMock(path, options);
    },
    writeFileSync: (path: string, data: string) => {
      writeFileSyncMock(path, data);
    },
  };
});

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

const { ejectCommand } = await import('../../src/commands/eject.js');

beforeEach(() => {
  vi.clearAllMocks();
  // getSettings reads module-level settings state, which is not covered by fake transport seams.
  vi.spyOn(core, 'getSettings').mockReturnValue({
    commands: { default: { agent: 'claude' } },
  });
  existsSyncMock.mockReturnValue(false);
});

describe('ejectCommand', () => {
  it('writes a single prompt into the default agent directory', () => {
    ejectCommand('groom');

    const targetDir = path.resolve('.shipper', 'prompts', 'claude');
    const targetPath = path.resolve('.shipper', 'prompts', 'claude', 'groom.md');

    expect(mkdirSyncMock).toHaveBeenCalledWith(targetDir, { recursive: true });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      targetPath,
      core.agentPrompts.claude['groom.md']
    );
    expect(logSpy).toHaveBeenCalledWith(`[shipper] Wrote ${targetPath}`);
  });

  it('maps kebab-case CLI names to underscore filenames', () => {
    ejectCommand('pr-open');

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.resolve('.shipper', 'prompts', 'claude', 'pr_open.md'),
      core.agentPrompts.claude['pr_open.md']
    );
  });

  it('allows setup to be ejected explicitly', () => {
    ejectCommand('setup');

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.resolve('.shipper', 'prompts', 'claude', 'setup.md'),
      core.agentPrompts.claude['setup.md']
    );
  });

  it('uses the default agent even when per-step overrides are present', () => {
    // getSettings reads module-level settings state, which is not covered by fake transport seams.
    vi.spyOn(core, 'getSettings').mockReturnValue({
      commands: {
        default: { agent: 'claude' },
        implement: { agent: 'codex' },
      },
    });

    ejectCommand('implement');

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.resolve('.shipper', 'prompts', 'claude', 'implement.md'),
      core.agentPrompts.claude['implement.md']
    );
  });

  it('skips existing prompt files without overwriting', () => {
    const targetPath = path.resolve('.shipper', 'prompts', 'claude', 'pr_open.md');
    existsSyncMock.mockImplementation((candidate: string) => candidate === targetPath);

    ejectCommand('pr-open');

    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      `[shipper] Skipping pr-open — already exists at ${targetPath}`
    );
  });

  it('writes all workflow prompts and excludes setup.md when no name is provided', () => {
    ejectCommand();

    expect(writeFileSyncMock).toHaveBeenCalledTimes(9);

    const writtenPaths = writeFileSyncMock.mock.calls.map((call) => call[0]);
    expect(writtenPaths).toEqual([
      path.resolve('.shipper', 'prompts', 'claude', 'new.md'),
      path.resolve('.shipper', 'prompts', 'claude', 'groom.md'),
      path.resolve('.shipper', 'prompts', 'claude', 'design.md'),
      path.resolve('.shipper', 'prompts', 'claude', 'plan.md'),
      path.resolve('.shipper', 'prompts', 'claude', 'implement.md'),
      path.resolve('.shipper', 'prompts', 'claude', 'pr_open.md'),
      path.resolve('.shipper', 'prompts', 'claude', 'pr_review.md'),
      path.resolve('.shipper', 'prompts', 'claude', 'pr_remediate.md'),
      path.resolve('.shipper', 'prompts', 'claude', 'unblock.md'),
    ]);
    expect(writtenPaths.some((writtenPath) => writtenPath.endsWith('setup.md'))).toBe(false);
    expect(writtenPaths.some((writtenPath) => writtenPath.endsWith('setup_remediate.md'))).toBe(
      false
    );
    expect(logSpy).toHaveBeenCalledWith('[shipper] Summary: wrote 9, skipped 0');
  });

  it('throws a helpful error for invalid prompt names', () => {
    expect(() => {
      ejectCommand('not-a-prompt');
    }).toThrow(
      'Error: Invalid prompt name "not-a-prompt". Valid prompt names: new, groom, design, plan, implement, pr-open, pr-review, pr-remediate, unblock, setup'
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('reports all-skipped runs as success', () => {
    existsSyncMock.mockReturnValue(true);

    ejectCommand();

    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[shipper] Summary: wrote 0, skipped 9');
  });
});
