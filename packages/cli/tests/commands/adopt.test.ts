import { describe, it, expect, vi, beforeEach } from 'vitest';

type ShipperCore = typeof import('@dnsquared/shipper-core');

const { mockGh } = vi.hoisted(() => ({
  mockGh: vi.fn<ShipperCore['gh']>(),
}));

vi.mock('@dnsquared/shipper-core', () => ({
  gh: mockGh,
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
  it('adopts a valid issue with no shipper labels', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return Promise.resolve({ stdout: JSON.stringify({ number: 42, labels: [] }), stderr: '' });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.reject(new Error('not a PR'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await adoptCommand('42');

    expect(mockGh).toHaveBeenCalledWith(['issue', 'edit', '42', '--add-label', 'shipper:new']);
    expect(mockConsoleLog).toHaveBeenCalledWith('Issue #42 adopted into shipper workflow.');
  });

  it('warns and does not modify an issue that already has shipper labels', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return Promise.resolve({
          stdout: JSON.stringify({ number: 42, labels: [{ name: 'shipper:groomed' }] }),
          stderr: '',
        });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.reject(new Error('not a PR'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await adoptCommand('42');

    expect(mockConsoleWarn).toHaveBeenCalledWith(
      'Warning: Issue #42 already has shipper label(s): shipper:groomed. No changes made.'
    );
    // Should not call gh issue edit
    const editCalls = mockGh.mock.calls.filter(
      ([args]) => args[0] === 'issue' && args[1] === 'edit'
    );
    expect(editCalls).toHaveLength(0);
  });

  it('exits with error for non-existent issue', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(adoptCommand('9999')).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Issue #9999 not found.');
  });

  it('exits with error when issue number is a pull request', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return Promise.resolve({ stdout: JSON.stringify({ number: 42, labels: [] }), stderr: '' });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.resolve({ stdout: JSON.stringify({ number: 42 }), stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(adoptCommand('42')).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: #42 is a pull request, not an issue.');
  });

  it('strips # prefix from issue number', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return Promise.resolve({ stdout: JSON.stringify({ number: 42, labels: [] }), stderr: '' });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.reject(new Error('not a PR'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await adoptCommand('#42');

    expect(mockGh).toHaveBeenCalledWith(['issue', 'view', '42', '--json', 'number,labels']);
  });

  it('exits with error for non-numeric input', async () => {
    await expect(adoptCommand('abc')).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Please provide a valid issue number.');
  });
});

describe('adoptAllCommand', () => {
  it('adopts multiple eligible issues, skips labeled ones', async () => {
    const issues = [
      { number: 10, labels: [] },
      { number: 11, labels: [{ name: 'shipper:groomed' }] },
      { number: 12, labels: [] },
      { number: 13, labels: [{ name: 'bug' }] },
    ];

    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return Promise.resolve({ stdout: JSON.stringify(issues), stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await adoptAllCommand();

    const editCalls = mockGh.mock.calls.filter(
      ([args]) => args[0] === 'issue' && args[1] === 'edit'
    );
    expect(editCalls).toHaveLength(3);
    expect(editCalls[0]?.[0]).toEqual(['issue', 'edit', '10', '--add-label', 'shipper:new']);
    expect(editCalls[1]?.[0]).toEqual(['issue', 'edit', '12', '--add-label', 'shipper:new']);
    expect(editCalls[2]?.[0]).toEqual(['issue', 'edit', '13', '--add-label', 'shipper:new']);
    expect(mockConsoleLog).toHaveBeenCalledWith('Adopted #10, #12, #13 into shipper workflow.');
  });

  it('prints message when no eligible issues found', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return Promise.resolve({
          stdout: JSON.stringify([{ number: 5, labels: [{ name: 'shipper:new' }] }]),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await adoptAllCommand();

    expect(mockConsoleLog).toHaveBeenCalledWith('No eligible issues found.');
    const editCalls = mockGh.mock.calls.filter(
      ([args]) => args[0] === 'issue' && args[1] === 'edit'
    );
    expect(editCalls).toHaveLength(0);
  });

  it('exits with error when gh issue list fails', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return Promise.reject(new Error('gh issue list failed'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(adoptAllCommand()).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Failed to fetch issues.');
  });

  it('continues labeling remaining issues when one fails', async () => {
    const issues = [
      { number: 10, labels: [] },
      { number: 12, labels: [] },
      { number: 13, labels: [] },
    ];

    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return Promise.resolve({ stdout: JSON.stringify(issues), stderr: '' });
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args[2] === '12') {
        return Promise.reject(new Error('API error'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(adoptAllCommand()).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      "Error: Failed to add 'shipper:new' label to issue #12."
    );
    expect(mockConsoleLog).toHaveBeenCalledWith('Adopted #10, #13 into shipper workflow.');
  });

  it('handles empty repo with no issues', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return Promise.resolve({ stdout: JSON.stringify([]), stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await adoptAllCommand();

    expect(mockConsoleLog).toHaveBeenCalledWith('No eligible issues found.');
    const editCalls = mockGh.mock.calls.filter(
      ([args]) => args[0] === 'issue' && args[1] === 'edit'
    );
    expect(editCalls).toHaveLength(0);
  });
});
