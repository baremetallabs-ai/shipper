import { describe, expect, it } from 'vitest';
import {
  BLOCKED_LABEL,
  FAILED_LABEL,
  GROOMED_LABEL,
  IMPLEMENTED_LABEL,
  LOCKED_LABEL,
  PLANNED_LABEL,
  PR_OPEN_LABEL,
  PR_REVIEWED_LABEL,
  PRIORITY_HIGH_LABEL,
  PRIORITY_LOW_LABEL,
} from '../../core/src/lib/labels.js';
import type { ListIssueItem } from '../../core/src/lib/github.js';
import * as autoShipModule from '../src/renderer/App.js';

type BackgroundCommandLike = {
  command: 'new' | 'ship' | 'init' | 'unblock';
  repo: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  issueNumber?: number;
  cancelled: boolean;
};

const {
  getActiveShipIssueNumbers,
  getBackgroundDetail,
  getBackgroundRetryPayload,
  getBackgroundTitle,
  getNextAutoShipFailureState,
  selectNextAutoShipIssue,
} = autoShipModule as {
  getActiveShipIssueNumbers: (commands: BackgroundCommandLike[], repo: string) => Set<number>;
  getBackgroundDetail: (input: {
    command: 'new' | 'ship' | 'init' | 'unblock';
    status: 'queued' | 'running' | 'complete' | 'failed';
    repo: string;
    issueNumber?: number;
    merge?: boolean;
    latestOutput?: string | null;
    cancelled?: boolean;
  }) => string;
  getBackgroundRetryPayload: (
    command: 'new' | 'ship' | 'init' | 'unblock',
    repo: string,
    request?: string,
    issueNumber?: number,
    merge?: boolean
  ) =>
    | { command: 'new'; repo: string; request: string }
    | { command: 'ship'; repo: string; issueNumber: number; merge: boolean }
    | { command: 'init'; repo: string }
    | { command: 'unblock'; repo: string; issueNumber: number }
    | undefined;
  getBackgroundTitle: (
    command: 'new' | 'ship' | 'init' | 'unblock',
    repo: string,
    issueNumber?: number,
    merge?: boolean
  ) => string;
  getNextAutoShipFailureState: (
    status: 'complete' | 'failed',
    issueNumber: number | undefined,
    currentFailures: number,
    currentSkipped: Set<number>
  ) => {
    consecutiveFailures: number;
    skippedIssueNumbers: Set<number>;
    pauseAutoShip: boolean;
  };
  selectNextAutoShipIssue: (
    issues: ListIssueItem[],
    activeIssueNumbers: Set<number>,
    skippedIssueNumbers: Set<number>
  ) => ListIssueItem | null;
};

function createIssue(number: number, labels: string[]): ListIssueItem {
  return {
    number,
    title: `Issue ${number}`,
    labels,
    state: 'OPEN',
    author: 'octocat',
    createdAt: '2026-03-19T00:00:00Z',
  };
}

describe('selectNextAutoShipIssue', () => {
  it('prefers higher priority over lower priority within the same stage', () => {
    const issues = [
      createIssue(10, [PLANNED_LABEL, PRIORITY_LOW_LABEL]),
      createIssue(11, [PLANNED_LABEL, PRIORITY_HIGH_LABEL]),
    ];

    expect(selectNextAutoShipIssue(issues, new Set(), new Set())?.number).toBe(11);
  });

  it('prefers high-priority earlier-stage work over normal-priority later-stage work', () => {
    const issues = [
      createIssue(20, [PR_REVIEWED_LABEL]),
      createIssue(21, [GROOMED_LABEL, PRIORITY_HIGH_LABEL]),
    ];

    expect(selectNextAutoShipIssue(issues, new Set(), new Set())?.number).toBe(21);
  });

  it('excludes blocked, failed, locked, active, and skipped issues', () => {
    const issues = [
      createIssue(30, [PR_OPEN_LABEL, BLOCKED_LABEL]),
      createIssue(31, [PR_REVIEWED_LABEL, FAILED_LABEL]),
      createIssue(32, [PR_REVIEWED_LABEL, LOCKED_LABEL]),
      createIssue(33, [IMPLEMENTED_LABEL]),
      createIssue(34, [PLANNED_LABEL]),
      createIssue(35, [GROOMED_LABEL]),
    ];

    const activeIssueNumbers = new Set([33]);
    const skippedIssueNumbers = new Set([34]);

    expect(selectNextAutoShipIssue(issues, activeIssueNumbers, skippedIssueNumbers)?.number).toBe(
      35
    );
  });

  it('returns null when no eligible issues remain', () => {
    const issues = [
      createIssue(40, [PR_REVIEWED_LABEL, BLOCKED_LABEL]),
      createIssue(41, [PR_OPEN_LABEL, FAILED_LABEL]),
      createIssue(42, [PR_OPEN_LABEL, LOCKED_LABEL]),
      createIssue(43, [IMPLEMENTED_LABEL]),
    ];

    expect(selectNextAutoShipIssue(issues, new Set([43]), new Set())).toBeNull();
  });
});

describe('getActiveShipIssueNumbers', () => {
  it('returns queued and running ship issue numbers for the matching repo only', () => {
    const commands = [
      {
        id: 'ship-queued',
        command: 'ship',
        repo: 'owner/repo',
        status: 'queued',
        title: 'Ship #51',
        detail: 'Queued',
        output: '',
        issueNumber: 51,
        cancelled: false,
      },
      {
        id: 'ship-running',
        command: 'ship',
        repo: 'owner/repo',
        status: 'running',
        title: 'Ship #52',
        detail: 'Running',
        output: '',
        issueNumber: 52,
        cancelled: false,
      },
      {
        id: 'ship-complete',
        command: 'ship',
        repo: 'owner/repo',
        status: 'complete',
        title: 'Ship #53',
        detail: 'Complete',
        output: '',
        issueNumber: 53,
        cancelled: false,
      },
      {
        id: 'ship-failed',
        command: 'ship',
        repo: 'owner/repo',
        status: 'failed',
        title: 'Ship #54',
        detail: 'Failed',
        output: '',
        issueNumber: 54,
        cancelled: false,
      },
      {
        id: 'ship-cancelled',
        command: 'ship',
        repo: 'owner/repo',
        status: 'running',
        title: 'Ship #55',
        detail: 'Cancelled',
        output: '',
        issueNumber: 55,
        cancelled: true,
      },
      {
        id: 'ship-other-repo',
        command: 'ship',
        repo: 'owner/other',
        status: 'queued',
        title: 'Ship #56',
        detail: 'Queued',
        output: '',
        issueNumber: 56,
        cancelled: false,
      },
      {
        id: 'new-command',
        command: 'new',
        repo: 'owner/repo',
        status: 'running',
        title: 'New issue',
        detail: 'Running',
        output: '',
        cancelled: false,
      },
      {
        id: 'unblock-command',
        command: 'unblock',
        repo: 'owner/repo',
        status: 'running',
        title: 'Unblock #57',
        detail: 'Running',
        output: '',
        issueNumber: 57,
        cancelled: false,
      },
    ];

    expect(getActiveShipIssueNumbers(commands, 'owner/repo')).toEqual(new Set([51, 52]));
  });
});

describe('merge-aware background helpers', () => {
  it('renders unblock titles and detail copy', () => {
    expect(getBackgroundTitle('unblock', 'owner/repo', 70)).toBe('Unblock #70');
    expect(
      getBackgroundDetail({
        command: 'unblock',
        status: 'running',
        repo: 'owner/repo',
        issueNumber: 70,
      })
    ).toBe('Unblocking #70...');
    expect(
      getBackgroundDetail({
        command: 'unblock',
        status: 'complete',
        repo: 'owner/repo',
        issueNumber: 70,
      })
    ).toBe('Unblock completed');
  });

  it('adds the merge suffix to ship titles only when merge is enabled', () => {
    expect(getBackgroundTitle('ship', 'owner/repo', 71, true)).toBe('Ship #71 · merge');
    expect(getBackgroundTitle('ship', 'owner/repo', 71, false)).toBe('Ship #71');
  });

  it('distinguishes merge-enabled completed ships in the detail copy', () => {
    expect(
      getBackgroundDetail({
        command: 'ship',
        status: 'complete',
        repo: 'owner/repo',
        issueNumber: 72,
        merge: true,
      })
    ).toBe('Ship completed · merged');
    expect(
      getBackgroundDetail({
        command: 'ship',
        status: 'complete',
        repo: 'owner/repo',
        issueNumber: 72,
        merge: false,
      })
    ).toBe('Ship completed');
  });

  it('preserves merge mode in ship retry payloads', () => {
    expect(getBackgroundRetryPayload('ship', 'owner/repo', undefined, 73, true)).toEqual({
      command: 'ship',
      repo: 'owner/repo',
      issueNumber: 73,
      merge: true,
    });
    expect(getBackgroundRetryPayload('ship', 'owner/repo', undefined, 74, false)).toEqual({
      command: 'ship',
      repo: 'owner/repo',
      issueNumber: 74,
      merge: false,
    });
  });

  it('builds unblock retry payloads from the issue number', () => {
    expect(getBackgroundRetryPayload('unblock', 'owner/repo', undefined, 75)).toEqual({
      command: 'unblock',
      repo: 'owner/repo',
      issueNumber: 75,
    });
  });
});

describe('getNextAutoShipFailureState', () => {
  it('increments consecutive failures and records skipped issues on failure', () => {
    const result = getNextAutoShipFailureState('failed', 61, 0, new Set());

    expect(result.consecutiveFailures).toBe(1);
    expect(result.skippedIssueNumbers).toEqual(new Set([61]));
    expect(result.pauseAutoShip).toBe(false);
  });

  it('resets consecutive failures on success while preserving skipped issues', () => {
    const result = getNextAutoShipFailureState('complete', 62, 2, new Set([60]));

    expect(result.consecutiveFailures).toBe(0);
    expect(result.skippedIssueNumbers).toEqual(new Set([60]));
    expect(result.pauseAutoShip).toBe(false);
  });

  it('pauses auto-ship after the third consecutive failure', () => {
    const result = getNextAutoShipFailureState('failed', 63, 2, new Set([61, 62]));

    expect(result.consecutiveFailures).toBe(3);
    expect(result.skippedIssueNumbers).toEqual(new Set([61, 62, 63]));
    expect(result.pauseAutoShip).toBe(true);
  });
});
