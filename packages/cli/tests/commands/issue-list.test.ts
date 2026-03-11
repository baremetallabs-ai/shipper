import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGh, stageLabels, displayNameMap, controlLabelNames } = vi.hoisted(() => ({
  mockGh: vi.fn(),
  stageLabels: [
    'shipper:new',
    'shipper:groomed',
    'shipper:designed',
    'shipper:planned',
    'shipper:implemented',
    'shipper:pr-open',
    'shipper:pr-reviewed',
    'shipper:ready',
  ],
  displayNameMap: {
    'shipper:new': 'New',
    'shipper:groomed': 'Groomed',
    'shipper:designed': 'Designed',
    'shipper:planned': 'Planned',
    'shipper:implemented': 'Implemented',
    'shipper:pr-open': 'PR Open',
    'shipper:pr-reviewed': 'PR Reviewed',
    'shipper:ready': 'Ready',
  },
  controlLabelNames: ['shipper:blocked', 'shipper:locked'],
}));

vi.mock('@dnsquared/shipper-core', () => ({
  gh: (...args: unknown[]) => mockGh(...args),
  STAGE_LABEL_NAMES: stageLabels,
  DISPLAY_NAME_MAP: displayNameMap,
  CONTROL_LABEL_NAMES: controlLabelNames,
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
  mockGh.mockResolvedValue({ stdout: JSON.stringify(issues), stderr: '' });
}

describe('issueListCommand', () => {
  it('groups issues by pipeline stage in order with counts', async () => {
    mockGhIssueList([
      { number: 5, title: 'Feature A', labels: [{ name: 'shipper:new' }] },
      { number: 3, title: 'Feature B', labels: [{ name: 'shipper:new' }] },
      { number: 10, title: 'Feature C', labels: [{ name: 'shipper:planned' }] },
      { number: 7, title: 'Feature D', labels: [{ name: 'shipper:implemented' }] },
    ]);

    await issueListCommand({});

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

  it('assigns multi-status-label issue to the most-advanced stage', async () => {
    mockGhIssueList([
      {
        number: 42,
        title: 'Multi-label issue',
        labels: [{ name: 'shipper:groomed' }, { name: 'shipper:planned' }],
      },
    ]);

    await issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['\nPlanned (1)', '  #42 Multi-label issue']);
  });

  it('shows [blocked] suffix for blocked issues', async () => {
    mockGhIssueList([
      {
        number: 15,
        title: 'Blocked issue',
        labels: [{ name: 'shipper:designed' }, { name: 'shipper:blocked' }],
      },
    ]);

    await issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toContain('  #15 Blocked issue [blocked]');
  });

  it('shows [locked] suffix for locked issues', async () => {
    mockGhIssueList([
      {
        number: 20,
        title: 'Locked issue',
        labels: [{ name: 'shipper:planned' }, { name: 'shipper:locked' }],
      },
    ]);

    await issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toContain('  #20 Locked issue [locked]');
  });

  it('shows both [blocked] and [locked] suffixes together', async () => {
    mockGhIssueList([
      {
        number: 25,
        title: 'Both labels',
        labels: [{ name: 'shipper:new' }, { name: 'shipper:blocked' }, { name: 'shipper:locked' }],
      },
    ]);

    await issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toContain('  #25 Both labels [blocked] [locked]');
  });

  it('prints friendly message when no issues exist', async () => {
    mockGhIssueList([]);

    await issueListCommand({});

    expect(mockConsoleLog).toHaveBeenCalledWith('No shipper-managed issues found.');
  });

  it('filters to a single status with --status flag', async () => {
    mockGhIssueList([
      { number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] },
      { number: 2, title: 'Issue B', labels: [{ name: 'shipper:planned' }] },
      { number: 3, title: 'Issue C', labels: [{ name: 'shipper:planned' }] },
    ]);

    await issueListCommand({ status: 'planned' });

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['\nPlanned (2)', '  #2 Issue B', '  #3 Issue C']);
  });

  it('prints friendly message when --status filter matches no issues', async () => {
    mockGhIssueList([{ number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] }]);

    await issueListCommand({ status: 'planned' });

    expect(mockConsoleLog).toHaveBeenCalledWith('No shipper-managed issues found.');
  });

  it('exits non-zero with error for invalid --status value', async () => {
    await expect(issueListCommand({ status: 'foo' })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      "Error: Invalid status 'foo'. Valid values: new, groomed, designed, planned, implemented, pr-open, pr-reviewed, ready"
    );
  });

  it('omits empty status groups from output', async () => {
    mockGhIssueList([
      { number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] },
      { number: 2, title: 'Issue B', labels: [{ name: 'shipper:ready' }] },
    ]);

    await issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    // Only New and Ready headings should appear — no Groomed, Designed, etc.
    expect(calls).toEqual(['\nNew (1)', '  #1 Issue A', '\nReady (1)', '  #2 Issue B']);
  });

  it('sorts issues within each group by number ascending', async () => {
    mockGhIssueList([
      { number: 50, title: 'Z', labels: [{ name: 'shipper:new' }] },
      { number: 10, title: 'A', labels: [{ name: 'shipper:new' }] },
      { number: 30, title: 'M', labels: [{ name: 'shipper:new' }] },
    ]);

    await issueListCommand({});

    const calls = mockConsoleLog.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['\nNew (3)', '  #10 A', '  #30 M', '  #50 Z']);
  });

  it('exits non-zero when gh call fails', async () => {
    mockGh.mockRejectedValue(new Error('gh failed'));

    await expect(issueListCommand({})).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Failed to fetch issues.');
  });
});
