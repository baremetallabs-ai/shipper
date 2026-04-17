import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseIssueTitleLabelsList } from '../../../core/src/lib/gh-schemas.js';

const {
  mockGh,
  stageLabels,
  displayNameMap,
  controlLabelNames,
  blockedLabel,
  failedLabel,
  lockedLabel,
} = vi.hoisted(() => ({
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
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
  controlLabelNames: ['shipper:blocked', 'shipper:locked', 'shipper:failed'],
  blockedLabel: 'shipper:blocked',
  failedLabel: 'shipper:failed',
  lockedLabel: 'shipper:locked',
}));

vi.mock('@dnsquared/shipper-core', () => ({
  logger: {
    error: (message: string) => {
      console.error(`[shipper] ${message}`);
    },
    log: (message: string) => {
      console.log(`[shipper] ${message}`);
    },
    warn: (message: string) => {
      console.warn(`[shipper] ${message}`);
    },
  },
  gh: (args: string[]) => mockGh(args),
  parseIssueTitleLabelsList,
  STAGE_LABEL_NAMES: stageLabels,
  DISPLAY_NAME_MAP: displayNameMap,
  CONTROL_LABEL_NAMES: controlLabelNames,
  BLOCKED_LABEL: blockedLabel,
  FAILED_LABEL: failedLabel,
  LOCKED_LABEL: lockedLabel,
}));

import { issueListCommand } from '../../src/commands/issue-list.js';

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
});

function mockGhIssueList(issues: { number: number; title: string; labels: { name: string }[] }[]) {
  mockGh.mockResolvedValue({ stdout: JSON.stringify(issues), stderr: '' });
}

function loggedLines(): string[] {
  return mockConsoleLog.mock.calls.map(([message]) => String(message));
}

function prefixed(lines: string[]): string[] {
  return lines.map((line) => `[shipper] ${line}`);
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

    const calls = loggedLines();
    expect(calls).toEqual(
      prefixed([
        '\nNew (2)',
        '  #3 Feature B',
        '  #5 Feature A',
        '\nPlanned (1)',
        '  #10 Feature C',
        '\nImplemented (1)',
        '  #7 Feature D',
      ])
    );
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

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nPlanned (1)', '  #42 Multi-label issue']));
  });

  it('shows blocked issues in a dedicated Blocked section with stage context', async () => {
    mockGhIssueList([
      {
        number: 15,
        title: 'Blocked issue',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nBlocked (1)', '  #15 Blocked issue [designed]']));
  });

  it('shows failed issues in a dedicated Failed section with stage context', async () => {
    mockGhIssueList([
      {
        number: 16,
        title: 'Failed issue',
        labels: [{ name: 'shipper:planned' }, { name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nFailed (1)', '  #16 Failed issue [planned]']));
  });

  it('shows blocked and failed sections after stage groups in that order', async () => {
    mockGhIssueList([
      { number: 1, title: 'New issue', labels: [{ name: 'shipper:new' }] },
      {
        number: 2,
        title: 'Blocked issue',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
      {
        number: 3,
        title: 'Failed issue',
        labels: [{ name: 'shipper:planned' }, { name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(
      prefixed([
        '\nNew (1)',
        '  #1 New issue',
        '\nBlocked (1)',
        '  #2 Blocked issue [designed]',
        '\nFailed (1)',
        '  #3 Failed issue [planned]',
      ])
    );
  });

  it('shows an issue with both blocked and failed only in Failed', async () => {
    mockGhIssueList([
      {
        number: 17,
        title: 'Dual-control issue',
        labels: [{ name: 'shipper:planned' }, { name: blockedLabel }, { name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nFailed (1)', '  #17 Dual-control issue [planned]']));
  });

  it('shows [locked] suffix for locked issues', async () => {
    mockGhIssueList([
      {
        number: 20,
        title: 'Locked issue',
        labels: [{ name: 'shipper:planned' }, { name: lockedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toContain('[shipper]   #20 Locked issue [locked]');
  });

  it('shows both stage and locked suffixes for blocked locked issues', async () => {
    mockGhIssueList([
      {
        number: 25,
        title: 'Both labels',
        labels: [{ name: 'shipper:new' }, { name: blockedLabel }, { name: lockedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nBlocked (1)', '  #25 Both labels [new] [locked]']));
  });

  it('prints friendly message when no issues exist', async () => {
    mockGhIssueList([]);

    await issueListCommand({});

    expect(mockConsoleLog).toHaveBeenCalledWith('[shipper] No shipper-managed issues found.');
  });

  it('filters to only blocked issues with --status blocked', async () => {
    mockGhIssueList([
      {
        number: 2,
        title: 'Blocked issue',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
      {
        number: 3,
        title: 'Failed issue',
        labels: [{ name: 'shipper:planned' }, { name: failedLabel }],
      },
      { number: 4, title: 'Normal issue', labels: [{ name: 'shipper:new' }] },
    ]);

    await issueListCommand({ status: 'blocked' });

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nBlocked (1)', '  #2 Blocked issue [designed]']));
  });

  it('filters to only failed issues with --status failed', async () => {
    mockGhIssueList([
      {
        number: 2,
        title: 'Blocked issue',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
      {
        number: 3,
        title: 'Failed issue',
        labels: [{ name: 'shipper:planned' }, { name: failedLabel }],
      },
      { number: 4, title: 'Normal issue', labels: [{ name: 'shipper:new' }] },
    ]);

    await issueListCommand({ status: 'failed' });

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nFailed (1)', '  #3 Failed issue [planned]']));
  });

  it('filters to a single stage while still showing matching blocked and failed sections', async () => {
    mockGhIssueList([
      { number: 1, title: 'Issue A', labels: [{ name: 'shipper:designed' }] },
      {
        number: 2,
        title: 'Blocked designed issue',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
      {
        number: 3,
        title: 'Failed designed issue',
        labels: [{ name: 'shipper:designed' }, { name: failedLabel }],
      },
      {
        number: 4,
        title: 'Blocked planned issue',
        labels: [{ name: 'shipper:planned' }, { name: blockedLabel }],
      },
    ]);

    await issueListCommand({ status: 'designed' });

    const calls = loggedLines();
    expect(calls).toEqual(
      prefixed([
        '\nDesigned (1)',
        '  #1 Issue A',
        '\nBlocked (1)',
        '  #2 Blocked designed issue [designed]',
        '\nFailed (1)',
        '  #3 Failed designed issue [designed]',
      ])
    );
  });

  it('prints friendly message when --status filter matches no issues', async () => {
    mockGhIssueList([{ number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] }]);

    await issueListCommand({ status: 'planned' });

    expect(mockConsoleLog).toHaveBeenCalledWith('[shipper] No shipper-managed issues found.');
  });

  it('throws for invalid --status value', async () => {
    await expect(issueListCommand({ status: 'foo' })).rejects.toThrow(
      "Error: Invalid status 'foo'. Valid values: new, groomed, designed, planned, implemented, pr-open, pr-reviewed, ready, blocked, failed"
    );
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('omits empty status groups from output', async () => {
    mockGhIssueList([
      { number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] },
      { number: 2, title: 'Issue B', labels: [{ name: 'shipper:ready' }] },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    // Only New and Ready headings should appear — no Groomed, Designed, etc.
    expect(calls).toEqual(prefixed(['\nNew (1)', '  #1 Issue A', '\nReady (1)', '  #2 Issue B']));
  });

  it('omits empty Blocked and Failed sections from output', async () => {
    mockGhIssueList([{ number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] }]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nNew (1)', '  #1 Issue A']));
  });

  it('excludes blocked and failed issues from stage group counts', async () => {
    mockGhIssueList([
      { number: 1, title: 'Normal designed issue', labels: [{ name: 'shipper:designed' }] },
      {
        number: 2,
        title: 'Blocked designed issue',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
      {
        number: 3,
        title: 'Failed designed issue',
        labels: [{ name: 'shipper:designed' }, { name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(
      prefixed([
        '\nDesigned (1)',
        '  #1 Normal designed issue',
        '\nBlocked (1)',
        '  #2 Blocked designed issue [designed]',
        '\nFailed (1)',
        '  #3 Failed designed issue [designed]',
      ])
    );
  });

  it('sorts issues within each group by number ascending', async () => {
    mockGhIssueList([
      { number: 50, title: 'Z', labels: [{ name: 'shipper:new' }] },
      { number: 10, title: 'A', labels: [{ name: 'shipper:new' }] },
      { number: 30, title: 'M', labels: [{ name: 'shipper:new' }] },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nNew (3)', '  #10 A', '  #30 M', '  #50 Z']));
  });

  it('sorts blocked and failed sections by issue number ascending', async () => {
    mockGhIssueList([
      {
        number: 30,
        title: 'Blocked Z',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
      {
        number: 10,
        title: 'Blocked A',
        labels: [{ name: 'shipper:new' }, { name: blockedLabel }],
      },
      {
        number: 20,
        title: 'Failed M',
        labels: [{ name: 'shipper:planned' }, { name: failedLabel }],
      },
      {
        number: 5,
        title: 'Failed A',
        labels: [{ name: 'shipper:groomed' }, { name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(
      prefixed([
        '\nBlocked (2)',
        '  #10 Blocked A [new]',
        '  #30 Blocked Z [designed]',
        '\nFailed (2)',
        '  #5 Failed A [groomed]',
        '  #20 Failed M [planned]',
      ])
    );
  });

  it('throws when gh call fails', async () => {
    mockGh.mockRejectedValue(new Error('gh failed'));

    await expect(issueListCommand({})).rejects.toThrow('Error: Failed to fetch issues.');
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('shows a stageless failed issue in Failed with no stage suffix', async () => {
    mockGhIssueList([
      {
        number: 42,
        title: 'Stageless failed',
        labels: [{ name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nFailed (1)', '  #42 Stageless failed']));
  });

  it('shows a stageless blocked issue in Blocked with no stage suffix', async () => {
    mockGhIssueList([
      {
        number: 43,
        title: 'Stageless blocked',
        labels: [{ name: blockedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(prefixed(['\nBlocked (1)', '  #43 Stageless blocked']));
  });

  it('--status failed includes stageless failed issues', async () => {
    mockGhIssueList([
      {
        number: 10,
        title: 'Staged failed',
        labels: [{ name: 'shipper:designed' }, { name: failedLabel }],
      },
      {
        number: 11,
        title: 'Stageless failed',
        labels: [{ name: failedLabel }],
      },
    ]);

    await issueListCommand({ status: 'failed' });

    const calls = loggedLines();
    expect(calls).toEqual(
      prefixed(['\nFailed (2)', '  #10 Staged failed [designed]', '  #11 Stageless failed'])
    );
  });

  it('--status blocked includes stageless blocked issues', async () => {
    mockGhIssueList([
      {
        number: 20,
        title: 'Staged blocked',
        labels: [{ name: 'shipper:planned' }, { name: blockedLabel }],
      },
      {
        number: 21,
        title: 'Stageless blocked',
        labels: [{ name: blockedLabel }],
      },
    ]);

    await issueListCommand({ status: 'blocked' });

    const calls = loggedLines();
    expect(calls).toEqual(
      prefixed(['\nBlocked (2)', '  #20 Staged blocked [planned]', '  #21 Stageless blocked'])
    );
  });

  it('shows stageless and staged control issues together correctly', async () => {
    mockGhIssueList([
      { number: 1, title: 'Normal issue', labels: [{ name: 'shipper:new' }] },
      {
        number: 2,
        title: 'Staged blocked',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
      {
        number: 3,
        title: 'Stageless blocked',
        labels: [{ name: blockedLabel }],
      },
      {
        number: 4,
        title: 'Staged failed',
        labels: [{ name: 'shipper:planned' }, { name: failedLabel }],
      },
      {
        number: 5,
        title: 'Stageless failed',
        labels: [{ name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    const calls = loggedLines();
    expect(calls).toEqual(
      prefixed([
        '\nNew (1)',
        '  #1 Normal issue',
        '\nBlocked (2)',
        '  #2 Staged blocked [designed]',
        '  #3 Stageless blocked',
        '\nFailed (2)',
        '  #4 Staged failed [planned]',
        '  #5 Stageless failed',
      ])
    );
  });
});
