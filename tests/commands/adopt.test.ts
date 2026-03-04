import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { adoptCommand, adoptAllCommand } from '../../src/commands/adopt.js';

// Prevent process.exit from actually exiting
const _mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('adoptCommand', () => {
  it('adopts a valid issue with no shipper labels', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ number: 42, labels: [] });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        throw new Error('not a PR');
      }
      return '';
    });

    adoptCommand('42');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '42', '--add-label', 'shipper:new'],
      expect.any(Object)
    );
    expect(mockConsoleLog).toHaveBeenCalledWith('Issue #42 adopted into shipper workflow.');
  });

  it('warns and does not modify an issue that already has shipper labels', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ number: 42, labels: [{ name: 'shipper:groomed' }] });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        throw new Error('not a PR');
      }
      return '';
    });

    adoptCommand('42');

    expect(mockConsoleWarn).toHaveBeenCalledWith(
      'Warning: Issue #42 already has shipper label(s): shipper:groomed. No changes made.'
    );
    // Should not call gh issue edit
    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls).toHaveLength(0);
  });

  it('exits with error for non-existent issue', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        throw new Error('not found');
      }
      return '';
    });

    expect(() => adoptCommand('9999')).toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Issue #9999 not found.');
  });

  it('exits with error when issue number is a pull request', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ number: 42, labels: [] });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ number: 42 });
      }
      return '';
    });

    expect(() => adoptCommand('42')).toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: #42 is a pull request, not an issue.');
  });

  it('strips # prefix from issue number', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ number: 42, labels: [] });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        throw new Error('not a PR');
      }
      return '';
    });

    adoptCommand('#42');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '42', '--json', 'number,labels'],
      expect.any(Object)
    );
  });

  it('exits with error for non-numeric input', () => {
    expect(() => adoptCommand('abc')).toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Please provide a valid issue number.');
  });
});

describe('adoptAllCommand', () => {
  it('adopts multiple eligible issues, skips labeled ones', () => {
    const issues = [
      { number: 10, labels: [] },
      { number: 11, labels: [{ name: 'shipper:groomed' }] },
      { number: 12, labels: [] },
      { number: 13, labels: [{ name: 'bug' }] },
    ];

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify(issues);
      }
      return '';
    });

    adoptAllCommand();

    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls).toHaveLength(3);
    expect(editCalls[0]![1]).toEqual(['issue', 'edit', '10', '--add-label', 'shipper:new']);
    expect(editCalls[1]![1]).toEqual(['issue', 'edit', '12', '--add-label', 'shipper:new']);
    expect(editCalls[2]![1]).toEqual(['issue', 'edit', '13', '--add-label', 'shipper:new']);
    expect(mockConsoleLog).toHaveBeenCalledWith('Adopted #10, #12, #13 into shipper workflow.');
  });

  it('prints message when no eligible issues found', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([{ number: 5, labels: [{ name: 'shipper:new' }] }]);
      }
      return '';
    });

    adoptAllCommand();

    expect(mockConsoleLog).toHaveBeenCalledWith('No eligible issues found.');
    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls).toHaveLength(0);
  });

  it('exits with error when gh issue list fails', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        throw new Error('gh issue list failed');
      }
      return '';
    });

    expect(() => adoptAllCommand()).toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Failed to fetch issues.');
  });

  it('continues labeling remaining issues when one fails', () => {
    const issues = [
      { number: 10, labels: [] },
      { number: 12, labels: [] },
      { number: 13, labels: [] },
    ];

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify(issues);
      }
      if (args[0] === 'issue' && args[1] === 'edit' && (args as string[])[2] === '12') {
        throw new Error('API error');
      }
      return '';
    });

    expect(() => adoptAllCommand()).toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      "Error: Failed to add 'shipper:new' label to issue #12."
    );
    expect(mockConsoleLog).toHaveBeenCalledWith('Adopted #10, #13 into shipper workflow.');
  });

  it('handles empty repo with no issues', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([]);
      }
      return '';
    });

    adoptAllCommand();

    expect(mockConsoleLog).toHaveBeenCalledWith('No eligible issues found.');
    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls).toHaveLength(0);
  });
});
