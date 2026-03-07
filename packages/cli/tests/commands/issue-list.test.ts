import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { issueListCommand } from '../../src/commands/issue-list.js';

// Prevent process.exit from actually exiting
const _mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
});

function mockGhIssueList(issues: { number: number; title: string; labels: { name: string }[] }[]) {
  mockExecFileSync.mockReturnValue(JSON.stringify(issues));
}

describe('issueListCommand', () => {
  it('groups issues by pipeline stage in order with counts', () => {
    mockGhIssueList([
      { number: 5, title: 'Feature A', labels: [{ name: 'shipper:new' }] },
      { number: 3, title: 'Feature B', labels: [{ name: 'shipper:new' }] },
      { number: 10, title: 'Feature C', labels: [{ name: 'shipper:planned' }] },
      { number: 7, title: 'Feature D', labels: [{ name: 'shipper:implemented' }] },
    ]);

    issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      '\nNew (2)',
      '  #3 Feature B',
      '  #5 Feature A',
      '\nPlanned (1)',
      '  #10 Feature C',
      '\nImplemented (1)',
      '  #7 Feature D',
    ]);
  });

  it('assigns multi-status-label issue to the most-advanced stage', () => {
    mockGhIssueList([
      {
        number: 42,
        title: 'Multi-label issue',
        labels: [{ name: 'shipper:groomed' }, { name: 'shipper:planned' }],
      },
    ]);

    issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['\nPlanned (1)', '  #42 Multi-label issue']);
  });

  it('shows [blocked] suffix for blocked issues', () => {
    mockGhIssueList([
      {
        number: 15,
        title: 'Blocked issue',
        labels: [{ name: 'shipper:designed' }, { name: 'shipper:blocked' }],
      },
    ]);

    issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toContain('  #15 Blocked issue [blocked]');
  });

  it('shows [locked] suffix for locked issues', () => {
    mockGhIssueList([
      {
        number: 20,
        title: 'Locked issue',
        labels: [{ name: 'shipper:planned' }, { name: 'shipper:locked' }],
      },
    ]);

    issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toContain('  #20 Locked issue [locked]');
  });

  it('shows both [blocked] and [locked] suffixes together', () => {
    mockGhIssueList([
      {
        number: 25,
        title: 'Both labels',
        labels: [{ name: 'shipper:new' }, { name: 'shipper:blocked' }, { name: 'shipper:locked' }],
      },
    ]);

    issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toContain('  #25 Both labels [blocked] [locked]');
  });

  it('prints friendly message when no issues exist', () => {
    mockGhIssueList([]);

    issueListCommand({});

    expect(mockConsoleLog).toHaveBeenCalledWith('No shipper-managed issues found.');
  });

  it('filters to a single status with --status flag', () => {
    mockGhIssueList([
      { number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] },
      { number: 2, title: 'Issue B', labels: [{ name: 'shipper:planned' }] },
      { number: 3, title: 'Issue C', labels: [{ name: 'shipper:planned' }] },
    ]);

    issueListCommand({ status: 'planned' });

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['\nPlanned (2)', '  #2 Issue B', '  #3 Issue C']);
  });

  it('prints friendly message when --status filter matches no issues', () => {
    mockGhIssueList([{ number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] }]);

    issueListCommand({ status: 'planned' });

    expect(mockConsoleLog).toHaveBeenCalledWith('No shipper-managed issues found.');
  });

  it('exits non-zero with error for invalid --status value', () => {
    expect(() => issueListCommand({ status: 'foo' })).toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      "Error: Invalid status 'foo'. Valid values: new, groomed, designed, planned, implemented, pr-open, pr-reviewed, ready"
    );
  });

  it('omits empty status groups from output', () => {
    mockGhIssueList([
      { number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] },
      { number: 2, title: 'Issue B', labels: [{ name: 'shipper:ready' }] },
    ]);

    issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    // Only New and Ready headings should appear — no Groomed, Designed, etc.
    expect(calls).toEqual(['\nNew (1)', '  #1 Issue A', '\nReady (1)', '  #2 Issue B']);
  });

  it('sorts issues within each group by number ascending', () => {
    mockGhIssueList([
      { number: 50, title: 'Z', labels: [{ name: 'shipper:new' }] },
      { number: 10, title: 'A', labels: [{ name: 'shipper:new' }] },
      { number: 30, title: 'M', labels: [{ name: 'shipper:new' }] },
    ]);

    issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['\nNew (3)', '  #10 A', '  #30 M', '  #50 Z']);
  });

  it('exits non-zero when gh call fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gh failed');
    });

    expect(() => issueListCommand({})).toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Failed to fetch issues.');
  });
});
