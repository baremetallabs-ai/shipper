import { describe, expect, it } from 'vitest';
import {
  BLOCKED_LABEL,
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
  command: 'new' | 'ship' | 'init';
  repo: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  issueNumber?: number;
  cancelled: boolean;
};

const { getActiveShipIssueNumbers, getNextAutoShipFailureState, selectNextAutoShipIssue } =
  autoShipModule as {
    getActiveShipIssueNumbers: (commands: BackgroundCommandLike[], repo: string) => Set<number>;
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

  it('excludes blocked, locked, active, and skipped issues', () => {
    const issues = [
      createIssue(30, [PR_OPEN_LABEL, BLOCKED_LABEL]),
      createIssue(31, [PR_REVIEWED_LABEL, LOCKED_LABEL]),
      createIssue(32, [IMPLEMENTED_LABEL]),
      createIssue(33, [PLANNED_LABEL]),
      createIssue(34, [GROOMED_LABEL]),
    ];

    const activeIssueNumbers = new Set([32]);
    const skippedIssueNumbers = new Set([33]);

    expect(selectNextAutoShipIssue(issues, activeIssueNumbers, skippedIssueNumbers)?.number).toBe(
      34
    );
  });

  it('returns null when no eligible issues remain', () => {
    const issues = [
      createIssue(40, [PR_REVIEWED_LABEL, BLOCKED_LABEL]),
      createIssue(41, [PR_OPEN_LABEL, LOCKED_LABEL]),
      createIssue(42, [IMPLEMENTED_LABEL]),
    ];

    expect(selectNextAutoShipIssue(issues, new Set([42]), new Set())).toBeNull();
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
    ];

    expect(getActiveShipIssueNumbers(commands, 'owner/repo')).toEqual(new Set([51, 52]));
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
