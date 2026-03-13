import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@dnsquared/shipper-core', () => ({
  runPreflight: vi.fn(),
  loadSettings: vi.fn(),
  CLI_VERSION: '0.1.0-test',
  checkVersionFreshness: vi.fn(),
  getRepoNwo: vi.fn(async () => 'owner/repo'),
}));

vi.mock('../src/commands/init.js', () => ({ initCommand: vi.fn() }));
vi.mock('../src/commands/new.js', () => ({ newCommand: vi.fn() }));
vi.mock('../src/commands/adopt.js', () => ({
  adoptCommand: vi.fn(),
  adoptAllCommand: vi.fn(),
}));
vi.mock('../src/commands/groom.js', () => ({ groomCommand: vi.fn() }));
vi.mock('../src/commands/design.js', () => ({ designCommand: vi.fn() }));
vi.mock('../src/commands/plan.js', () => ({ planCommand: vi.fn() }));
vi.mock('../src/commands/next.js', () => ({ nextCommand: vi.fn() }));
vi.mock('../src/commands/ship.js', () => ({ shipCommand: vi.fn(async () => {}) }));
vi.mock('../src/commands/implement.js', () => ({ implementCommand: vi.fn() }));
vi.mock('../src/commands/eject.js', () => ({ ejectCommand: vi.fn() }));
vi.mock('../src/commands/pr-review.js', () => ({ prReviewCommand: vi.fn() }));
vi.mock('../src/commands/pr-open.js', () => ({ prOpenCommand: vi.fn() }));
vi.mock('../src/commands/pr-remediate.js', () => ({ prRemediateCommand: vi.fn() }));
vi.mock('../src/commands/merge.js', () => ({ mergeCommand: vi.fn() }));
vi.mock('../src/commands/reset.js', () => ({ resetCommand: vi.fn() }));
vi.mock('../src/commands/unblock.js', () => ({ unblockCommand: vi.fn() }));
vi.mock('../src/commands/unlock.js', () => ({ unlockCommand: vi.fn() }));
vi.mock('../src/commands/issue-list.js', () => ({ issueListCommand: vi.fn() }));
vi.mock('../src/commands/setup.js', () => ({ setupCommand: vi.fn() }));

import { shipCommand } from '../src/commands/ship.js';
import { ejectCommand } from '../src/commands/eject.js';
import { newCommand } from '../src/commands/new.js';
import { groomCommand } from '../src/commands/groom.js';
import { prReviewCommand } from '../src/commands/pr-review.js';
import { setupCommand } from '../src/commands/setup.js';
import { unlockCommand } from '../src/commands/unlock.js';
import { runPreflight, loadSettings, getRepoNwo } from '@dnsquared/shipper-core';

const mockShipCommand = vi.mocked(shipCommand);
const mockEjectCommand = vi.mocked(ejectCommand);
const mockNewCommand = vi.mocked(newCommand);
const mockGroomCommand = vi.mocked(groomCommand);
const mockPrReviewCommand = vi.mocked(prReviewCommand);
const mockSetupCommand = vi.mocked(setupCommand);
const mockUnlockCommand = vi.mocked(unlockCommand);
const mockRunPreflight = vi.mocked(runPreflight);
const mockLoadSettings = vi.mocked(loadSettings);
const mockGetRepoNwo = vi.mocked(getRepoNwo);

describe('shipper-cli', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { stdio: 'ignore' });
  });

  it('shows help with available commands', () => {
    const output = execFileSync('node', ['dist/index.js', '--help'], {
      encoding: 'utf-8',
    });
    expect(output).toContain('init');
    expect(output).toContain('new');
    expect(output).toContain('groom');
    expect(output).toContain('design');
    expect(output).toContain('plan');
    expect(output).toContain('eject');
    expect(output).toContain('pr');
  });

  it('shows --mode on prompt-running command help and removes --headless from new', () => {
    const newHelp = execFileSync('node', ['dist/index.js', 'new', '--help'], {
      encoding: 'utf-8',
    });
    const setupHelp = execFileSync('node', ['dist/index.js', 'setup', '--help'], {
      encoding: 'utf-8',
    });

    expect(newHelp).toContain('--mode <mode>');
    expect(newHelp).not.toContain('--headless');
    expect(setupHelp).toContain('--mode <mode>');
  });

  describe('eject command wiring', () => {
    const originalArgv = [...process.argv];

    beforeEach(() => {
      vi.resetModules();
      mockEjectCommand.mockReset();
      mockRunPreflight.mockClear();
      mockLoadSettings.mockClear();
      mockGetRepoNwo.mockClear();
    });

    afterEach(() => {
      process.argv = [...originalArgv];
    });

    async function importEntrypoint() {
      await import('../src/index.ts');
    }

    it('registers the eject command and runs preflight before invoking it', async () => {
      process.argv = ['node', 'src/index.ts', 'eject', 'groom'];

      await importEntrypoint();

      expect(mockEjectCommand).toHaveBeenCalledWith('groom');
      expect(mockLoadSettings).toHaveBeenCalled();
      expect(mockGetRepoNwo).toHaveBeenCalled();
      expect(mockRunPreflight).toHaveBeenCalledWith('owner/repo');
    });
  });

  describe('prompt command mode wiring', () => {
    const originalArgv = [...process.argv];
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code ?? 0}`);
      }) as typeof process.exit);
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.resetModules();
      mockNewCommand.mockReset();
      mockGroomCommand.mockReset();
      mockPrReviewCommand.mockReset();
      mockSetupCommand.mockReset();
      mockRunPreflight.mockClear();
      mockLoadSettings.mockClear();
      mockGetRepoNwo.mockClear();
      exitSpy.mockClear();
      errorSpy.mockClear();
    });

    afterEach(() => {
      process.argv = [...originalArgv];
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    async function importEntrypoint() {
      await import('../src/index.ts');
    }

    it('passes mode to newCommand', async () => {
      process.argv = ['node', 'src/index.ts', 'new', 'request', '--mode', 'headless'];

      await importEntrypoint();

      expect(mockNewCommand).toHaveBeenCalledWith(['request'], { mode: 'headless' });
    });

    it('passes mode through groomCommand options', async () => {
      process.argv = ['node', 'src/index.ts', 'groom', '42', '--mode', 'interactive'];

      await importEntrypoint();

      expect(mockGetRepoNwo).toHaveBeenCalled();
      expect(mockGroomCommand).toHaveBeenCalledWith('owner/repo', '42', {
        auto: false,
        mode: 'interactive',
        agent: undefined,
      });
    });

    it('passes mode to pr review', async () => {
      process.argv = ['node', 'src/index.ts', 'pr', 'review', '7', '--mode', 'interactive'];

      await importEntrypoint();

      expect(mockPrReviewCommand).toHaveBeenCalledWith('owner/repo', '7', 'interactive', undefined);
    });

    it('loads settings explicitly for setup and does not run preflight', async () => {
      process.argv = ['node', 'src/index.ts', 'setup', 'repo', '--mode', 'headless'];

      await importEntrypoint();

      expect(mockLoadSettings).toHaveBeenCalled();
      expect(mockRunPreflight).not.toHaveBeenCalled();
      expect(mockSetupCommand).toHaveBeenCalledWith(['repo'], { mode: 'headless' });
    });

    it('rejects the removed --headless option on new', async () => {
      process.argv = ['node', 'src/index.ts', 'new', 'request', '--headless'];

      await expect(importEntrypoint()).rejects.toThrow('process.exit:1');
      expect(mockNewCommand).not.toHaveBeenCalled();
    });

    it('prints thrown command errors and exits 1 via the CLI wrapper', async () => {
      mockGroomCommand.mockRejectedValueOnce(new Error('boom'));
      process.argv = ['node', 'src/index.ts', 'groom', '42'];

      await expect(importEntrypoint()).rejects.toThrow('process.exit:1');

      expect(errorSpy).toHaveBeenCalledWith('boom');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('unlock command wiring', () => {
    const originalArgv = [...process.argv];

    beforeEach(() => {
      vi.resetModules();
      mockUnlockCommand.mockReset();
      mockRunPreflight.mockClear();
      mockLoadSettings.mockClear();
      mockGetRepoNwo.mockClear();
    });

    afterEach(() => {
      process.argv = [...originalArgv];
    });

    async function importEntrypoint() {
      await import('../src/index.ts');
    }

    it('passes an explicit issue to unlockCommand', async () => {
      process.argv = ['node', 'src/index.ts', 'unlock', '42'];

      await importEntrypoint();

      expect(mockUnlockCommand).toHaveBeenCalledTimes(1);
      expect(mockUnlockCommand).toHaveBeenCalledWith(
        'owner/repo',
        '42',
        expect.objectContaining({})
      );
      expect(mockUnlockCommand.mock.calls[0]?.[2]?.stale).toBeUndefined();
    });

    it('passes --stale without an issue to unlockCommand', async () => {
      process.argv = ['node', 'src/index.ts', 'unlock', '--stale'];

      await importEntrypoint();

      expect(mockUnlockCommand).toHaveBeenCalledTimes(1);
      expect(mockUnlockCommand).toHaveBeenCalledWith(
        'owner/repo',
        undefined,
        expect.objectContaining({ stale: true })
      );
    });
  });

  describe('ship command parallel validation', () => {
    const originalArgv = [...process.argv];
    let exitSpy: ReturnType<typeof vi.spyOn>;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code ?? 0}`);
      }) as typeof process.exit);
      vi.resetModules();
      mockShipCommand.mockReset();
      mockShipCommand.mockResolvedValue(undefined);
      errorSpy.mockClear();
      mockGetRepoNwo.mockClear();
      exitSpy.mockClear();
    });

    afterEach(() => {
      process.argv = [...originalArgv];
      exitSpy.mockRestore();
    });

    async function importEntrypoint() {
      await import('../src/index.ts');
    }

    it('errors when --parallel is used without --auto', async () => {
      process.argv = ['node', 'src/index.ts', 'ship', '42', '--parallel', '3'];

      await expect(importEntrypoint()).rejects.toThrow('process.exit:1');
      expect(mockShipCommand).not.toHaveBeenCalled();
    });

    it('errors when --parallel is missing its numeric value', async () => {
      process.argv = ['node', 'src/index.ts', 'ship', '--auto', '--parallel'];

      await expect(importEntrypoint()).rejects.toThrow();
      expect(mockShipCommand).not.toHaveBeenCalled();

      try {
        execFileSync('node', ['dist/index.js', 'ship', '--auto', '--parallel'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect.fail('Expected the built CLI to reject a missing --parallel value');
      } catch (error) {
        expect(error).toMatchObject({
          stderr: expect.stringContaining('Error: --parallel requires a number'),
        });
      }
    });

    it('normalizes --parallel 1 back to the sequential path', async () => {
      process.argv = ['node', 'src/index.ts', 'ship', '--auto', '--parallel', '1'];

      await importEntrypoint();

      expect(mockShipCommand).toHaveBeenCalledWith('owner/repo', undefined, {
        merge: false,
        auto: true,
        parallel: undefined,
        agent: undefined,
      });
    });

    it('passes through an explicit parallel slot count', async () => {
      process.argv = ['node', 'src/index.ts', 'ship', '--auto', '--parallel', '3'];

      await importEntrypoint();

      expect(mockShipCommand).toHaveBeenCalledWith('owner/repo', undefined, {
        merge: false,
        auto: true,
        parallel: 3,
        agent: undefined,
      });
    });

    it('keeps non-ship commands on normal unknown-option handling', async () => {
      process.argv = ['node', 'src/index.ts', 'groom', '--parallel'];

      await expect(importEntrypoint()).rejects.toThrow('process.exit:1');
      expect(errorSpy).not.toHaveBeenCalledWith('Error: --parallel requires a number');
      expect(mockShipCommand).not.toHaveBeenCalled();
    });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
