import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  existsSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  getSettingsMock,
  claudePrompts,
  codexPrompts,
} = vi.hoisted(() => {
  const claudeRegistry = {
    'new.md': 'claude new',
    'groom.md': 'claude groom',
    'design.md': 'claude design',
    'plan.md': 'claude plan',
    'implement.md': 'claude implement',
    'pr_open.md': 'claude pr open',
    'pr_review.md': 'claude pr review',
    'pr_remediate.md': 'claude pr remediate',
    'unblock.md': 'claude unblock',
    'setup.md': 'claude setup',
  };

  const codexRegistry = {
    'new.md': 'codex new',
    'groom.md': 'codex groom',
    'design.md': 'codex design',
    'plan.md': 'codex plan',
    'implement.md': 'codex implement',
    'pr_open.md': 'codex pr open',
    'pr_review.md': 'codex pr review',
    'pr_remediate.md': 'codex pr remediate',
    'unblock.md': 'codex unblock',
    'setup.md': 'codex setup',
  };

  return {
    existsSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    getSettingsMock: vi.fn(),
    claudePrompts: claudeRegistry,
    codexPrompts: codexRegistry,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  };
});

vi.mock('@dnsquared/shipper-core', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
  agentPrompts: {
    claude: claudePrompts,
    codex: codexPrompts,
  },
}));

const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit:${code ?? 0}`);
}) as typeof process.exit);
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

const { ejectCommand } = await import('../../src/commands/eject.js');

beforeEach(() => {
  vi.clearAllMocks();
  getSettingsMock.mockReturnValue({
    agents: { default: 'claude' },
  });
  existsSyncMock.mockReturnValue(false);
});

describe('ejectCommand', () => {
  it('writes a single prompt into the default agent directory', () => {
    ejectCommand('groom');

    const targetDir = path.resolve('.shipper', 'prompts', 'claude');
    const targetPath = path.resolve('.shipper', 'prompts', 'claude', 'groom.md');

    expect(mkdirSyncMock).toHaveBeenCalledWith(targetDir, { recursive: true });
    expect(writeFileSyncMock).toHaveBeenCalledWith(targetPath, 'claude groom');
    expect(logSpy).toHaveBeenCalledWith(`Wrote ${targetPath}`);
  });

  it('maps kebab-case CLI names to underscore filenames', () => {
    ejectCommand('pr-open');

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.resolve('.shipper', 'prompts', 'claude', 'pr_open.md'),
      'claude pr open'
    );
  });

  it('uses the default agent even when per-step overrides are present', () => {
    getSettingsMock.mockReturnValue({
      agents: { default: 'claude', implement: 'codex' },
    });

    ejectCommand('implement');

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.resolve('.shipper', 'prompts', 'claude', 'implement.md'),
      'claude implement'
    );
  });

  it('skips existing prompt files without overwriting', () => {
    const targetPath = path.resolve('.shipper', 'prompts', 'claude', 'pr_open.md');
    existsSyncMock.mockImplementation((candidate: string) => candidate === targetPath);

    ejectCommand('pr-open');

    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(`Skipping pr-open — already exists at ${targetPath}`);
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
    expect(writtenPaths.some((writtenPath) => String(writtenPath).endsWith('setup.md'))).toBe(
      false
    );
    expect(logSpy).toHaveBeenCalledWith('Summary: wrote 9, skipped 0');
  });

  it('prints a helpful error and exits 1 for invalid prompt names', () => {
    expect(() => ejectCommand('not-a-prompt')).toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      'Error: Invalid prompt name "not-a-prompt". Valid prompt names: new, groom, design, plan, implement, pr-open, pr-review, pr-remediate, unblock'
    );
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('reports all-skipped runs as success', () => {
    existsSyncMock.mockReturnValue(true);

    ejectCommand();

    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith('Summary: wrote 0, skipped 9');
  });
});
