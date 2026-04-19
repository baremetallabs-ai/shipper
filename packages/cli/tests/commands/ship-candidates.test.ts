import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';
import {
  AUTO_PRIORITY_LABELS,
  printUnblockSummary,
  selectBlockedIssues,
  selectNextCandidate,
} from '../../src/commands/ship-candidates.js';
import type { UnblockAttempt } from '../../src/commands/ship-candidates.js';

type FakeCore = ReturnType<typeof createFakeCore>;
type IssueSeed = {
  number: number;
  title: string;
  labels: string[];
  labelEvents?: Array<{ label: string; createdAt: string }>;
  lockTimestamps?: string[];
};

const osMockState = vi.hoisted(() => ({
  mockHomedir: vi.fn(() => '/mock-home'),
}));

vi.mock('../../src/commands/merge.js', () => ({
  postMerge: vi.fn(() => Promise.resolve()),
  pollPrMerged: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../src/commands/unblock.js', () => ({
  prepareUnblockContext: vi.fn(() => Promise.resolve()),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: osMockState.mockHomedir,
  };
});

function formatConsoleEntry(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function getConsoleEntries(spy: { mock: { calls: readonly unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => formatConsoleEntry(call[0]));
}

function getConsoleOutput(spy: { mock: { calls: readonly unknown[][] } }): string {
  return getConsoleEntries(spy).join('\n');
}

function prefixed(message: string): string {
  return `[shipper] ${message}`;
}

describe('ship-candidates', () => {
  let fake: FakeCore;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let labelEventsByIssue: Map<string, Array<{ label: string; createdAt: string }>>;
  let lockTimestampsByIssue: Map<string, string[]>;
  let timelineRequestIssueNumbers: string[];
  let issueListOverride: { stdout?: string; error?: Error } | undefined;

  const seedIssues = (...issues: IssueSeed[]): void => {
    for (const issue of issues) {
      fake.setIssue(String(issue.number), {
        title: issue.title,
        labels: issue.labels,
      });
      if (issue.labelEvents) {
        labelEventsByIssue.set(String(issue.number), issue.labelEvents);
      }
      if (issue.lockTimestamps) {
        lockTimestampsByIssue.set(String(issue.number), issue.lockTimestamps);
      }
    }
  };

  const installSelectorGhStubs = (): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'list' &&
        args.includes('--json') &&
        args.includes('number,title,labels')
      ) {
        if (issueListOverride?.error) {
          throw issueListOverride.error;
        }

        if (issueListOverride?.stdout !== undefined) {
          return { stdout: issueListOverride.stdout, stderr: '' };
        }

        const labels = args.flatMap((arg, index) =>
          arg === '--label' && args[index + 1] ? [String(args[index + 1])] : []
        );
        const search = args.includes('--search') ? (args[args.indexOf('--search') + 1] ?? '') : '';
        const excludedLabels = [...search.matchAll(/-label:([^\s]+)/g)].map((match) => match[1]);
        const primaryLabel = labels.find((label) => label !== 'shipper:locked');
        const requireLocked = labels.includes('shipper:locked');
        const payload = [...fake.state.issues.values()]
          .filter((issue) => (primaryLabel ? issue.labels.has(primaryLabel) : true))
          .filter((issue) => (requireLocked ? issue.labels.has('shipper:locked') : true))
          .filter((issue) => excludedLabels.every((label) => !issue.labels.has(label)))
          .map((issue) => ({
            number: Number(issue.number),
            title: issue.title,
            labels: [...issue.labels].map((name) => ({ name })),
          }));

        return { stdout: JSON.stringify(payload), stderr: '' };
      }

      if (
        args[0] === 'api' &&
        typeof args[1] === 'string' &&
        args[1].startsWith('repos/owner/repo/issues/') &&
        args[1].endsWith('/timeline')
      ) {
        const issueNumber = args[1].split('/')[4];
        if (!issueNumber) {
          throw new Error('missing issue number');
        }

        const jq = args.includes('--jq') ? (args[args.indexOf('--jq') + 1] ?? '') : '';
        if (jq.includes('.created_at')) {
          return {
            stdout: (lockTimestampsByIssue.get(issueNumber) ?? []).join('\n'),
            stderr: '',
          };
        }

        timelineRequestIssueNumbers.push(issueNumber);
        return {
          stdout: (labelEventsByIssue.get(issueNumber) ?? [])
            .map((event) =>
              JSON.stringify({
                event: 'labeled',
                label: { name: event.label },
                created_at: event.createdAt,
              })
            )
            .join('\n'),
          stderr: '',
        };
      }

      return undefined;
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    labelEventsByIssue = new Map();
    lockTimestampsByIssue = new Map();
    timelineRequestIssueNumbers = [];
    issueListOverride = undefined;
    installSelectorGhStubs();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.dispose();
  });

  describe('AUTO_PRIORITY_LABELS', () => {
    it('contains the expected auto-ship labels in priority order', () => {
      expect(AUTO_PRIORITY_LABELS).toEqual([
        'shipper:ready',
        'shipper:pr-reviewed',
        'shipper:pr-open',
        'shipper:implemented',
        'shipper:planned',
        'shipper:designed',
        'shipper:groomed',
      ]);
    });

    it('has shipper:ready as the highest priority', () => {
      expect(AUTO_PRIORITY_LABELS[0]).toBe('shipper:ready');
    });

    it('excludes shipper:new from auto-ship priorities', () => {
      expect(AUTO_PRIORITY_LABELS).not.toContain('shipper:new');
    });
  });

  describe('selectNextCandidate', () => {
    it('returns the issue from the highest-priority stage when priorities are equal', async () => {
      seedIssues(
        { number: 10, title: 'PR open issue', labels: ['shipper:pr-open'] },
        { number: 20, title: 'Groomed issue', labels: ['shipper:groomed'] }
      );

      const result = await selectNextCandidate('owner/repo', new Set());

      expect(result).toEqual({ number: 10, title: 'PR open issue' });
    });

    it('skips issues in the skippedIssues set', async () => {
      seedIssues(
        { number: 10, title: 'Skipped issue', labels: ['shipper:pr-open'] },
        { number: 11, title: 'Next issue', labels: ['shipper:pr-open'] }
      );

      const result = await selectNextCandidate('owner/repo', new Set([10]));

      expect(result).toEqual({ number: 11, title: 'Next issue' });
    });

    it('returns null when no candidates remain', async () => {
      const result = await selectNextCandidate('owner/repo', new Set());

      expect(result).toBeNull();
    });

    it('returns null when all non-new candidates are skipped', async () => {
      seedIssues(
        { number: 5, title: 'Only issue', labels: ['shipper:planned'] },
        { number: 6, title: 'New issue', labels: ['shipper:new'] }
      );

      const result = await selectNextCandidate('owner/repo', new Set([5]));

      expect(result).toBeNull();
    });

    it('does not fetch timelines when only one candidate exists across all stages', async () => {
      seedIssues({ number: 1, title: 'Only issue', labels: ['shipper:groomed'] });

      const result = await selectNextCandidate('owner/repo', new Set());

      expect(result).toEqual({ number: 1, title: 'Only issue' });
      expect(timelineRequestIssueNumbers).toEqual([]);
    });

    it('does not fetch timelines when the winning bucket has a single candidate', async () => {
      seedIssues(
        { number: 30, title: 'Normal PR open issue', labels: ['shipper:pr-open'] },
        {
          number: 40,
          title: 'High groomed issue',
          labels: ['shipper:groomed', 'shipper:priority-high'],
        },
        {
          number: 41,
          title: 'Normal groomed issue',
          labels: ['shipper:groomed'],
        }
      );

      const result = await selectNextCandidate('owner/repo', new Set());

      expect(result).toEqual({ number: 40, title: 'High groomed issue' });
      expect(timelineRequestIssueNumbers).toEqual([]);
    });

    it('fetches timelines only for the winning bucket when tie-breaking is needed', async () => {
      seedIssues(
        {
          number: 30,
          title: 'Non-winning issue',
          labels: ['shipper:pr-open', 'shipper:priority-low'],
        },
        {
          number: 1,
          title: 'Oldest',
          labels: ['shipper:groomed'],
          labelEvents: [{ label: 'shipper:groomed', createdAt: '2025-01-01T00:00:00Z' }],
        },
        {
          number: 2,
          title: 'Newer',
          labels: ['shipper:groomed'],
          labelEvents: [{ label: 'shipper:groomed', createdAt: '2025-01-02T00:00:00Z' }],
        }
      );

      const result = await selectNextCandidate('owner/repo', new Set());

      expect(result).toEqual({ number: 1, title: 'Oldest' });
      expect(timelineRequestIssueNumbers.sort()).toEqual(['1', '2']);
    });

    it('clears stale locks on the selected candidate', async () => {
      seedIssues({
        number: 7,
        title: 'Stale locked issue',
        labels: ['shipper:planned', 'shipper:locked'],
        lockTimestamps: [new Date(Date.now() - 31 * 60_000).toISOString()],
      });

      const result = await selectNextCandidate('owner/repo', new Set());

      expect(result).toEqual({ number: 7, title: 'Stale locked issue' });
      expect(fake.state.labelTransitions).toEqual([
        { target: 'issue', number: '7', add: [], remove: ['shipper:locked'] },
      ]);
    });

    it('skips issues already active in parallel slots', async () => {
      seedIssues(
        { number: 7, title: 'Active issue', labels: ['shipper:planned'] },
        { number: 8, title: 'Available issue', labels: ['shipper:planned'] }
      );

      const result = await selectNextCandidate('owner/repo', new Set(), new Set([7]));

      expect(result).toEqual({ number: 8, title: 'Available issue' });
    });

    it('prefers higher-priority issues over more advanced normal-priority issues', async () => {
      seedIssues(
        { number: 30, title: 'Normal PR open issue', labels: ['shipper:pr-open'] },
        {
          number: 40,
          title: 'High groomed issue',
          labels: ['shipper:groomed', 'shipper:priority-high'],
        }
      );

      const result = await selectNextCandidate('owner/repo', new Set());

      expect(result).toEqual({ number: 40, title: 'High groomed issue' });
    });
  });

  describe('selectBlockedIssues', () => {
    it('returns an empty array when no blocked issues exist', async () => {
      const result = await selectBlockedIssues('owner/repo');

      expect(result).toEqual([]);
    });

    it('returns issues sorted by stage priority', async () => {
      seedIssues(
        {
          number: 20,
          title: 'PR reviewed issue',
          labels: ['shipper:pr-reviewed', 'shipper:blocked'],
        },
        { number: 30, title: 'Planned issue', labels: ['shipper:planned', 'shipper:blocked'] }
      );

      const result = await selectBlockedIssues('owner/repo');

      expect(result).toEqual([
        { number: 20, title: 'PR reviewed issue' },
        { number: 30, title: 'Planned issue' },
      ]);
    });

    it('silently excludes blocked shipper:new issues from the unblock pass', async () => {
      seedIssues(
        { number: 10, title: 'New issue', labels: ['shipper:new', 'shipper:blocked'] },
        { number: 20, title: 'Planned issue', labels: ['shipper:planned', 'shipper:blocked'] }
      );

      const result = await selectBlockedIssues('owner/repo');

      expect(result).toEqual([{ number: 20, title: 'Planned issue' }]);
    });

    it('returns an empty array when gh throws and logs a warning', async () => {
      issueListOverride = { error: new Error('gh CLI error') };

      const result = await selectBlockedIssues('owner/repo');

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(prefixed('Failed to fetch blocked issues'));
    });

    it('throws the shared validation error when the blocked issues response is invalid JSON', async () => {
      issueListOverride = { stdout: '{not json' };

      await expect(selectBlockedIssues('owner/repo')).rejects.toThrow(
        'gh returned an invalid IssueTitleLabelsList payload: not valid JSON'
      );
    });

    it('excludes locked blocked issues from the unblock pass', async () => {
      seedIssues(
        {
          number: 10,
          title: 'Locked blocked issue',
          labels: ['shipper:planned', 'shipper:blocked', 'shipper:locked'],
        },
        {
          number: 20,
          title: 'Available blocked issue',
          labels: ['shipper:planned', 'shipper:blocked'],
        }
      );

      const result = await selectBlockedIssues('owner/repo');

      expect(result).toEqual([{ number: 20, title: 'Available blocked issue' }]);
    });

    it('sorts issues with no recognized stage label to the end', async () => {
      seedIssues(
        { number: 10, title: 'No stage label', labels: ['shipper:blocked', 'bug'] },
        { number: 20, title: 'Groomed issue', labels: ['shipper:groomed', 'shipper:blocked'] }
      );

      const result = await selectBlockedIssues('owner/repo');

      expect(result).toEqual([
        { number: 20, title: 'Groomed issue' },
        { number: 10, title: 'No stage label' },
      ]);
    });
  });

  describe('printUnblockSummary', () => {
    it('prints one final outcome row per issue in final-attempt order while preserving every unblock log file', () => {
      const attempts: UnblockAttempt[] = [
        {
          issue: 12,
          title: 'Fix database migration',
          outcome: 'still blocked',
          logFile: '/mock-home/.shipper/logs/unblock-12-20260318T040000.log',
        },
        {
          issue: 15,
          title: 'Add OAuth provider',
          outcome: 'still blocked',
          logFile: '/mock-home/.shipper/logs/unblock-15-20260318T040000.log',
        },
        {
          issue: 12,
          title: 'Fix database migration',
          outcome: 'unblocked',
          logFile: '/mock-home/.shipper/logs/unblock-12-20260318T050000.log',
        },
      ];

      printUnblockSummary(attempts, '/mock-home');

      const entries = getConsoleEntries(logSpy);
      const output = getConsoleOutput(logSpy);
      const outcomeRows = entries.filter((entry) => entry.includes('unblock #'));
      const retriedIssueRows = entries.filter((entry) => entry.includes('Fix database migration'));
      const singleAttemptIssueRows = entries.filter((entry) =>
        entry.includes('Add OAuth provider')
      );

      expect(output).toContain('Unblock attempts:');
      expect(outcomeRows[0]).toContain('Add OAuth provider');
      expect(outcomeRows[1]).toContain('Fix database migration');
      expect(retriedIssueRows).toHaveLength(1);
      expect(retriedIssueRows[0]).toContain('unblock #12');
      expect(retriedIssueRows[0]).toContain('✓ unblocked');
      expect(singleAttemptIssueRows).toHaveLength(1);
      expect(singleAttemptIssueRows[0]).toContain('unblock #15');
      expect(singleAttemptIssueRows[0]).toContain('— still blocked');
      expect(output).toContain('Unblock log files:');
      expect(output).toContain('~/.shipper/logs/unblock-12-20260318T040000.log');
      expect(output).toContain('~/.shipper/logs/unblock-12-20260318T050000.log');
      expect(output).toContain('~/.shipper/logs/unblock-15-20260318T040000.log');
    });

    it('prints one still-blocked outcome row when the same issue remains blocked across attempts', () => {
      const attempts: UnblockAttempt[] = [
        {
          issue: 21,
          title: 'Stabilize flaky deployment',
          outcome: 'still blocked',
        },
        {
          issue: 21,
          title: 'Stabilize flaky deployment',
          outcome: 'still blocked',
        },
      ];

      printUnblockSummary(attempts);

      const entries = getConsoleEntries(logSpy);
      const blockedRows = entries.filter((entry) => entry.includes('Stabilize flaky deployment'));

      expect(blockedRows).toHaveLength(1);
      expect(blockedRows[0]).toContain('— still blocked');
    });

    it('truncates long titles to 42 chars plus an ellipsis', () => {
      const attempts: UnblockAttempt[] = [
        {
          issue: 99,
          title: 'This is a very long title that exceeds the forty-five character limit',
          outcome: 'unblocked',
        },
      ];

      printUnblockSummary(attempts);

      const output = getConsoleOutput(logSpy);
      expect(output).toContain('This is a very long title that exceeds the...');
      expect(output).not.toContain('forty-five character limit');
    });

    it('does not print the unblock log files section when no attempts have log files', () => {
      const attempts: UnblockAttempt[] = [
        { issue: 5, title: 'Legacy attempt', outcome: 'unblocked' },
      ];

      printUnblockSummary(attempts);

      const output = getConsoleOutput(logSpy);
      expect(output).not.toContain('Unblock log files:');
    });
  });
});
