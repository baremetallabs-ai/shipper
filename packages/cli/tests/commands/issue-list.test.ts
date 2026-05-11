import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';
import { issueListCommand } from '../../src/commands/issue-list.js';

type FakeCore = ReturnType<typeof createFakeCore>;

interface IssueFixture {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
}

const blockedLabel = 'shipper:blocked';
const failedLabel = 'shipper:failed';
const lockedLabel = 'shipper:locked';

function loggedLines(logSpy: MockInstance): string[] {
  return logSpy.mock.calls.map(([message]) => String(message));
}

function prefixed(lines: string[]): string[] {
  return lines.map((line) => line.replace(/^(\n*)/, '$1[shipper] '));
}

describe('issueListCommand', () => {
  let fake: FakeCore;
  let logSpy: MockInstance;
  let errorSpy: MockInstance;

  const stubIssueList = (issues: IssueFixture[]): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'list' &&
        args.includes('--json') &&
        args.includes('number,title,labels')
      ) {
        return {
          stdout: JSON.stringify(issues),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('groups issues by pipeline stage in order with counts', async () => {
    stubIssueList([
      { number: 5, title: 'Feature A', labels: [{ name: 'shipper:new' }] },
      { number: 3, title: 'Feature B', labels: [{ name: 'shipper:new' }] },
      { number: 10, title: 'Feature C', labels: [{ name: 'shipper:planned' }] },
      { number: 7, title: 'Feature D', labels: [{ name: 'shipper:implemented' }] },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(
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

  it('assigns multi-status-label issues to the most advanced stage', async () => {
    stubIssueList([
      {
        number: 42,
        title: 'Multi-label issue',
        labels: [{ name: 'shipper:groomed' }, { name: 'shipper:planned' }],
      },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(prefixed(['\nPlanned (1)', '  #42 Multi-label issue']));
  });

  it('shows blocked issues in a dedicated Blocked section with stage context', async () => {
    stubIssueList([
      {
        number: 15,
        title: 'Blocked issue',
        labels: [{ name: 'shipper:designed' }, { name: blockedLabel }],
      },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(
      prefixed(['\nBlocked (1)', '  #15 Blocked issue [designed]'])
    );
  });

  it('shows failed issues in a dedicated Failed section with stage context', async () => {
    stubIssueList([
      {
        number: 16,
        title: 'Failed issue',
        labels: [{ name: 'shipper:planned' }, { name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(prefixed(['\nFailed (1)', '  #16 Failed issue [planned]']));
  });

  it('shows blocked and failed sections after stage groups in that order', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(
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
    stubIssueList([
      {
        number: 17,
        title: 'Dual-control issue',
        labels: [{ name: 'shipper:planned' }, { name: blockedLabel }, { name: failedLabel }],
      },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(
      prefixed(['\nFailed (1)', '  #17 Dual-control issue [planned]'])
    );
  });

  it('shows a [locked] suffix for locked issues', async () => {
    stubIssueList([
      {
        number: 20,
        title: 'Locked issue',
        labels: [{ name: 'shipper:planned' }, { name: lockedLabel }],
      },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toContain('[shipper]   #20 Locked issue [locked]');
  });

  it('shows both stage and locked suffixes for blocked locked issues', async () => {
    stubIssueList([
      {
        number: 25,
        title: 'Both labels',
        labels: [{ name: 'shipper:new' }, { name: blockedLabel }, { name: lockedLabel }],
      },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(
      prefixed(['\nBlocked (1)', '  #25 Both labels [new] [locked]'])
    );
  });

  it('prints a friendly message when no issues exist', async () => {
    stubIssueList([]);

    await issueListCommand({});

    expect(logSpy).toHaveBeenCalledWith('[shipper] No shipper-managed issues found.');
  });

  it('filters to only blocked issues with --status blocked', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(
      prefixed(['\nBlocked (1)', '  #2 Blocked issue [designed]'])
    );
  });

  it('filters to only failed issues with --status failed', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(prefixed(['\nFailed (1)', '  #3 Failed issue [planned]']));
  });

  it('filters to a single stage while still showing matching blocked and failed sections', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(
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

  it('prints a friendly message when the --status filter matches no issues', async () => {
    stubIssueList([{ number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] }]);

    await issueListCommand({ status: 'planned' });

    expect(logSpy).toHaveBeenCalledWith('[shipper] No shipper-managed issues found.');
  });

  it('throws for invalid --status values', async () => {
    await expect(issueListCommand({ status: 'foo' })).rejects.toThrow(
      "Error: Invalid status 'foo'. Valid values: new, groomed, designed, planned, implemented, pr-open, pr-reviewed, ready, blocked, failed"
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('omits empty status groups from output', async () => {
    stubIssueList([
      { number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] },
      { number: 2, title: 'Issue B', labels: [{ name: 'shipper:ready' }] },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(
      prefixed(['\nNew (1)', '  #1 Issue A', '\nReady (1)', '  #2 Issue B'])
    );
  });

  it('omits empty Blocked and Failed sections from output', async () => {
    stubIssueList([{ number: 1, title: 'Issue A', labels: [{ name: 'shipper:new' }] }]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(prefixed(['\nNew (1)', '  #1 Issue A']));
  });

  it('excludes blocked and failed issues from stage group counts', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(
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

  it('sorts issues within each stage group by issue number ascending', async () => {
    stubIssueList([
      { number: 50, title: 'Z', labels: [{ name: 'shipper:new' }] },
      { number: 10, title: 'A', labels: [{ name: 'shipper:new' }] },
      { number: 30, title: 'M', labels: [{ name: 'shipper:new' }] },
    ]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(prefixed(['\nNew (3)', '  #10 A', '  #30 M', '  #50 Z']));
  });

  it('sorts blocked and failed sections by issue number ascending', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(
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

  it('throws when the gh issue list call fails', async () => {
    fake.stubGh((args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        throw new Error('gh failed');
      }
      return undefined;
    });

    await expect(issueListCommand({})).rejects.toThrow('Error: Failed to fetch issues.');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('shows a stageless failed issue in Failed with no stage suffix', async () => {
    stubIssueList([{ number: 42, title: 'Stageless failed', labels: [{ name: failedLabel }] }]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(prefixed(['\nFailed (1)', '  #42 Stageless failed']));
  });

  it('shows a stageless blocked issue in Blocked with no stage suffix', async () => {
    stubIssueList([{ number: 43, title: 'Stageless blocked', labels: [{ name: blockedLabel }] }]);

    await issueListCommand({});

    expect(loggedLines(logSpy)).toEqual(prefixed(['\nBlocked (1)', '  #43 Stageless blocked']));
  });

  it('--status failed includes stageless failed issues', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(
      prefixed(['\nFailed (2)', '  #10 Staged failed [designed]', '  #11 Stageless failed'])
    );
  });

  it('--status blocked includes stageless blocked issues', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(
      prefixed(['\nBlocked (2)', '  #20 Staged blocked [planned]', '  #21 Stageless blocked'])
    );
  });

  it('shows stageless and staged control issues together correctly', async () => {
    stubIssueList([
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

    expect(loggedLines(logSpy)).toEqual(
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
