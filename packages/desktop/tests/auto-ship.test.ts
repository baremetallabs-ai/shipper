import { describe, expect, it } from 'vitest';
import {
  BLOCKED_LABEL,
  DESIGNED_LABEL,
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
import {
  getActiveShipIssueNumbers,
  getBackgroundDetail,
  getBackgroundRetryPayload,
  getBackgroundTitle,
  getNextAutoShipFailureState,
  getWorkflowStageCacheKey,
  getWorkflowStageDisplayName,
  selectNextAutoShipIssue,
  selectNextAutoUnblockIssue,
  syncWorkflowStageCacheForRepo,
} from '../src/renderer/lib/app-utils.js';
import type { BackgroundCommandState } from '../src/renderer/types.js';

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
    const commands: BackgroundCommandState[] = [
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
  it('renders new and init titles', () => {
    expect(getBackgroundTitle('new', 'owner/repo')).toBe('New issue');
    expect(getBackgroundTitle('init', 'owner/repo')).toBe('Init owner/repo');
  });

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

  it('returns cancelled detail before any other status-specific copy', () => {
    expect(
      getBackgroundDetail({
        command: 'ship',
        status: 'failed',
        repo: 'owner/repo',
        issueNumber: 70,
        latestOutput: 'fatal: merge conflict',
        cancelled: true,
      })
    ).toBe('Cancelled');
  });

  it('uses failure output when present and a default failure message otherwise', () => {
    expect(
      getBackgroundDetail({
        command: 'ship',
        status: 'failed',
        repo: 'owner/repo',
        issueNumber: 70,
        latestOutput: 'fatal: merge conflict',
      })
    ).toBe('fatal: merge conflict');
    expect(
      getBackgroundDetail({
        command: 'new',
        status: 'failed',
        repo: 'owner/repo',
      })
    ).toBe('Command failed');
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

  it('uses the existing non-merge default detail copy for new, ship, and init commands', () => {
    expect(
      getBackgroundDetail({
        command: 'new',
        status: 'running',
        repo: 'owner/repo',
      })
    ).toBe('Creating issue...');
    expect(
      getBackgroundDetail({
        command: 'ship',
        status: 'running',
        repo: 'owner/repo',
        issueNumber: 72,
      })
    ).toBe('Shipping #72...');
    expect(
      getBackgroundDetail({
        command: 'init',
        status: 'running',
        repo: 'owner/repo',
      })
    ).toBe('Initializing owner/repo...');
  });

  it('builds new and init retry payloads', () => {
    expect(getBackgroundRetryPayload('new', 'owner/repo', 'Investigate flaky tests')).toEqual({
      command: 'new',
      repo: 'owner/repo',
      request: 'Investigate flaky tests',
    });
    expect(getBackgroundRetryPayload('init', 'owner/repo')).toEqual({
      command: 'init',
      repo: 'owner/repo',
    });
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

  it('returns undefined retry payloads when required command inputs are missing', () => {
    expect(getBackgroundRetryPayload('new', 'owner/repo')).toBeUndefined();
    expect(getBackgroundRetryPayload('ship', 'owner/repo')).toBeUndefined();
    expect(getBackgroundRetryPayload('unblock', 'owner/repo')).toBeUndefined();
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

  it('increments failures without adding a skipped issue when the failed command has no issue number', () => {
    const result = getNextAutoShipFailureState('failed', undefined, 1, new Set([61]));

    expect(result.consecutiveFailures).toBe(2);
    expect(result.skippedIssueNumbers).toEqual(new Set([61]));
    expect(result.pauseAutoShip).toBe(false);
  });
});

describe('selectNextAutoUnblockIssue', () => {
  it('skips queued issues that are locked by the time they are retried', () => {
    const issues = [
      createIssue(80, [PLANNED_LABEL, BLOCKED_LABEL, LOCKED_LABEL]),
      createIssue(81, [PLANNED_LABEL, BLOCKED_LABEL]),
    ];

    expect(selectNextAutoUnblockIssue(issues, [80, 81])).toEqual({
      issue: issues[1],
      remainingIssueNumbers: [],
    });
  });

  it('drops queue entries that are no longer blocked or no longer present', () => {
    const issues = [createIssue(91, [PLANNED_LABEL, BLOCKED_LABEL])];

    expect(selectNextAutoUnblockIssue(issues, [90, 92])).toEqual({
      issue: null,
      remainingIssueNumbers: [],
    });
  });
});

describe('getWorkflowStageDisplayName', () => {
  it('returns the most advanced workflow stage display name when multiple stage labels are present', () => {
    expect(
      getWorkflowStageDisplayName([GROOMED_LABEL, DESIGNED_LABEL, PLANNED_LABEL, LOCKED_LABEL])
    ).toBe('Planned');
  });

  it('returns undefined when labels contain no workflow stage', () => {
    expect(getWorkflowStageDisplayName([FAILED_LABEL, LOCKED_LABEL])).toBeUndefined();
  });
});

describe('workflow stage cache helpers', () => {
  it('uses the same repo and issue number key format for cache reads and writes', () => {
    expect(getWorkflowStageCacheKey('owner/repo', 42)).toBe('owner/repo:42');
  });

  it('refreshes one repo cache without disturbing another repo', () => {
    const current = new Map<string, string>([
      [getWorkflowStageCacheKey('owner/repo-a', 11), 'Groomed'],
      [getWorkflowStageCacheKey('owner/repo-a', 12), 'Planned'],
      [getWorkflowStageCacheKey('owner/repo-b', 21), 'Designed'],
    ]);

    const next = syncWorkflowStageCacheForRepo(current, 'owner/repo-a', [
      createIssue(12, [DESIGNED_LABEL]),
      createIssue(13, [PLANNED_LABEL]),
    ]);

    expect(next).toEqual(
      new Map<string, string>([
        [getWorkflowStageCacheKey('owner/repo-a', 12), 'Designed'],
        [getWorkflowStageCacheKey('owner/repo-a', 13), 'Planned'],
        [getWorkflowStageCacheKey('owner/repo-b', 21), 'Designed'],
      ])
    );
  });

  it('removes stale repo entries when refreshed issues disappear or no longer have a workflow stage', () => {
    const current = new Map<string, string>([
      [getWorkflowStageCacheKey('owner/repo-a', 11), 'Groomed'],
      [getWorkflowStageCacheKey('owner/repo-a', 12), 'Planned'],
      [getWorkflowStageCacheKey('owner/repo-b', 21), 'Designed'],
    ]);

    const next = syncWorkflowStageCacheForRepo(current, 'owner/repo-a', [
      createIssue(12, [FAILED_LABEL]),
      createIssue(14, [GROOMED_LABEL]),
    ]);

    expect(next).toEqual(
      new Map<string, string>([
        [getWorkflowStageCacheKey('owner/repo-a', 14), 'Groomed'],
        [getWorkflowStageCacheKey('owner/repo-b', 21), 'Designed'],
      ])
    );
  });

  it('clears all cached workflow stages for a repo when it is removed', () => {
    const current = new Map<string, string>([
      [getWorkflowStageCacheKey('owner/repo-a', 11), 'Groomed'],
      [getWorkflowStageCacheKey('owner/repo-a', 12), 'Planned'],
      [getWorkflowStageCacheKey('owner/repo-b', 21), 'Designed'],
    ]);

    const next = syncWorkflowStageCacheForRepo(current, 'owner/repo-a', []);

    expect(next).toEqual(
      new Map<string, string>([[getWorkflowStageCacheKey('owner/repo-b', 21), 'Designed']])
    );
  });
});
