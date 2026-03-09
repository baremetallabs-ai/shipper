import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@dnsquared/shipper-core', () => ({
  runPreflight: vi.fn(),
  loadSettings: vi.fn(),
  CLI_VERSION: '0.1.0-test',
  checkVersionFreshness: vi.fn(),
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
import { runPreflight, loadSettings } from '@dnsquared/shipper-core';

const mockShipCommand = vi.mocked(shipCommand);
const mockEjectCommand = vi.mocked(ejectCommand);
const mockRunPreflight = vi.mocked(runPreflight);
const mockLoadSettings = vi.mocked(loadSettings);

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

  describe('eject command wiring', () => {
    const originalArgv = [...process.argv];

    beforeEach(() => {
      vi.resetModules();
      mockEjectCommand.mockReset();
      mockRunPreflight.mockClear();
      mockLoadSettings.mockClear();
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
      expect(mockRunPreflight).toHaveBeenCalled();
    });
  });

  describe('ship command parallel validation', () => {
    const originalArgv = [...process.argv];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    beforeEach(() => {
      vi.resetModules();
      mockShipCommand.mockReset();
      mockShipCommand.mockResolvedValue(undefined);
      errorSpy.mockClear();
      exitSpy.mockClear();
    });

    afterEach(() => {
      process.argv = [...originalArgv];
    });

    afterAll(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    async function importEntrypoint() {
      await import('../src/index.ts');
    }

    it('errors when --parallel is used without --auto', async () => {
      process.argv = ['node', 'src/index.ts', 'ship', '42', '--parallel', '3'];

      await expect(importEntrypoint()).rejects.toThrow('process.exit:1');
      expect(errorSpy).toHaveBeenCalledWith('Error: --parallel requires --auto');
      expect(mockShipCommand).not.toHaveBeenCalled();
    });

    it('errors when --parallel is missing its numeric value', async () => {
      process.argv = ['node', 'src/index.ts', 'ship', '--auto', '--parallel'];

      await expect(importEntrypoint()).rejects.toThrow('process.exit:1');
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

      expect(mockShipCommand).toHaveBeenCalledWith(undefined, {
        merge: false,
        auto: true,
        parallel: undefined,
      });
    });

    it('passes through an explicit parallel slot count', async () => {
      process.argv = ['node', 'src/index.ts', 'ship', '--auto', '--parallel', '3'];

      await importEntrypoint();

      expect(mockShipCommand).toHaveBeenCalledWith(undefined, {
        merge: false,
        auto: true,
        parallel: 3,
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
