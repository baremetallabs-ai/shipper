import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/program.js';
import { commandPaths } from '../src/docs/command-extras.js';
import { discoverReferenceModel } from '../src/docs/cli-reference-generator.js';

describe('createProgram', () => {
  it('creates Commander metadata without parsing argv or exiting', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
    const originalArgv = process.argv;

    try {
      process.argv = ['node', 'shipper', 'ship', '--parallel'];
      const program = createProgram();

      expect(program.name()).toBe('shipper');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      exitSpy.mockRestore();
    }
  });

  it('discovers the expected leaf command set without groups or aliases', () => {
    const model = discoverReferenceModel(createProgram());
    const leafPaths = model.leaves.map((leaf) => leaf.pathSegments.join(' '));
    const groupPaths = model.groups.map((group) => group.pathSegments.join(' '));

    expect(new Set(leafPaths)).toEqual(new Set(commandPaths));
    expect(leafPaths).toHaveLength(commandPaths.length);
    expect(groupPaths).toEqual(['issue', 'pr']);
    expect(leafPaths).not.toContain('issue');
    expect(leafPaths).not.toContain('pr');
    expect(leafPaths).not.toContain('agent');
  });

  it('keeps representative Commander metadata on registered commands', () => {
    const program = createProgram();
    const setup = program.commands.find((command) => command.name() === 'setup');
    const priority = program.commands.find((command) => command.name() === 'priority');
    const ship = program.commands.find((command) => command.name() === 'ship');
    const next = program.commands.find((command) => command.name() === 'next');

    expect(setup?.aliases()).toEqual(['agent']);
    expect(priority?.registeredArguments.at(1)?.argChoices).toEqual(['high', 'normal', 'low']);
    expect(ship?.options.some((option) => option.long === '--parallel')).toBe(true);
    expect(next?.options.some((option) => option.long === '--disable-mcp')).toBe(true);
    expect(next?.options.some((option) => option.long === '--enable-mcp')).toBe(true);
  });

  it('keeps internal init check options out of public help metadata', () => {
    const program = createProgram();
    const init = program.commands.find((command) => command.name() === 'init');
    const longOptions = init?.options.map((option) => option.long);

    expect(longOptions).toEqual(['--agent', '--autocommit', '--push']);
    expect(longOptions).not.toContain('--offline');
    expect(longOptions).not.toContain('--check');
    expect(longOptions).not.toContain('--check-only');
  });
});
