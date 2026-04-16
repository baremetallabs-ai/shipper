import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toError, toErrorMessage } from '../../../core/src/lib/errors.js';

const osMockState = vi.hoisted(() => ({
  mockHomedir: vi.fn(() => '/mock-home'),
}));

const labelFixtures = vi.hoisted(() => ({
  stageLabelNames: [
    'shipper:new',
    'shipper:groomed',
    'shipper:designed',
    'shipper:planned',
    'shipper:implemented',
    'shipper:pr-open',
    'shipper:pr-reviewed',
    'shipper:ready',
  ],
  stageNameMap: {
    'shipper:new': 'groom',
    'shipper:groomed': 'design',
    'shipper:designed': 'plan',
    'shipper:planned': 'implement',
    'shipper:implemented': 'pr open',
    'shipper:pr-open': 'pr review',
    'shipper:pr-reviewed': 'pr remediate',
    'shipper:ready': 'ready',
  },
}));

vi.mock('../../src/commands/pr-remediate.js', () => ({
  buildReadyCheck: vi.fn(),
  SKIP_PR_REMEDIATE_WAIT_ENV_VAR: 'SHIPPER_SKIP_PR_REMEDIATE_WAIT',
}));

vi.mock('../../src/commands/merge.js', () => ({
  postMerge: vi.fn(() => Promise.resolve()),
  pollPrMerged: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../src/commands/unblock.js', () => ({
  prepareUnblockContext: vi.fn(() => Promise.resolve()),
}));

vi.mock('@dnsquared/shipper-core', () => ({
  ...(() => {
    const writeToStream = (
      stream:
        | { destroyed?: boolean; writableEnded?: boolean; write?: (chunk: string) => void }
        | undefined,
      line: string
    ) => {
      if (!stream || stream.destroyed || stream.writableEnded) {
        return;
      }
      stream.write?.(`${line}\n`);
    };

    const createMockLogger = (stream?: {
      destroyed?: boolean;
      writableEnded?: boolean;
      write?: (chunk: string) => void;
    }) => ({
      log: (message: string) => {
        const line = `[shipper] ${message}`;
        console.log(line);
        writeToStream(stream, line);
      },
      warn: (message: string) => {
        const line = `[shipper] ${message}`;
        console.warn(line);
        writeToStream(stream, line);
      },
      error: (message: string) => {
        const line = `[shipper] ${message}`;
        console.error(line);
        writeToStream(stream, line);
      },
    });

    return {
      logger: createMockLogger(),
      createLogger: ({ stream }: { stream?: { write?: (chunk: string) => void } } = {}) =>
        createMockLogger(stream),
    };
  })(),
  toError,
  toErrorMessage,
  aggregateSessionUsage: vi.fn(),
  classifyChecks: vi.fn(() => ({ pending: [], failed: [], passed: [], total: 0 })),
  clearStaleLockIfNeeded: vi.fn(() => Promise.resolve()),
  fetchChecks: vi.fn(() => Promise.resolve([])),
  fetchIssueTimelines: vi.fn(() => Promise.resolve(new Map())),
  getSettings: vi.fn(() => ({ prReviewWait: { mode: 'checks', maxDurationMinutes: 30 } })),
  gh: vi.fn(),
  handleAgentCrash: vi.fn(() => Promise.resolve()),
  processResult: vi.fn(() =>
    Promise.resolve({ verdict: 'accept' as const, comment: '.shipper/output/comment-7.md' })
  ),
  resolveMode: vi.fn(
    (_step: string, override?: 'headless' | 'interactive' | 'default') => override ?? 'default'
  ),
  retryOnInvalidOutput: vi.fn(() =>
    Promise.resolve({ verdict: 'accept' as const, comment: '.shipper/output/comment-7.md' })
  ),
  runPrompt: vi.fn(() => Promise.resolve(0)),
  scrubOutputDir: vi.fn(() => Promise.resolve()),
  selectIssuesForStage: vi.fn(() => Promise.resolve([])),
  sleepMs: vi.fn(() => Promise.resolve()),
  sortIssuesByLabelTime: vi.fn(<T>(issues: T[]) => issues),
  totalTokens: vi.fn((usage: { inputTokens: number; outputTokens: number }) => {
    return usage.inputTokens + usage.outputTokens;
  }),
  withIssueLock: vi.fn((_repo: string, _issue: string, fn: () => Promise<unknown>) => fn()),
  withStageHooks: vi.fn((_stage: string, _env: unknown, fn: () => Promise<unknown>) => fn()),
  STAGE_NAME_MAP: labelFixtures.stageNameMap,
  STAGE_LABEL_NAMES: labelFixtures.stageLabelNames,
  NEW_LABEL: 'shipper:new',
  PR_REVIEWED_LABEL: 'shipper:pr-reviewed',
  PRIORITY_LABEL_NAMES: ['shipper:priority-high', 'shipper:priority-low'],
  READY_LABEL: 'shipper:ready',
  BLOCKED_LABEL: 'shipper:blocked',
  LOCKED_LABEL: 'shipper:locked',
  FAILED_LABEL: 'shipper:failed',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: osMockState.mockHomedir,
  };
});

import {
  clearStaleLockIfNeeded,
  fetchIssueTimelines,
  gh,
  selectIssuesForStage,
  sortIssuesByLabelTime,
} from '@dnsquared/shipper-core';
import {
  AUTO_PRIORITY_LABELS,
  printUnblockSummary,
  selectBlockedIssues,
  selectNextCandidate,
} from '../../src/commands/ship-candidates.js';
import type { UnblockAttempt } from '../../src/commands/ship-candidates.js';

const mockClearStaleLockIfNeeded = vi.mocked(clearStaleLockIfNeeded);
const mockFetchIssueTimelines = vi.mocked(fetchIssueTimelines);
const mockGh = vi.mocked(gh);
const mockSelectIssuesForStage = vi.mocked(selectIssuesForStage);
const mockSortIssuesByLabelTime = vi.mocked(sortIssuesByLabelTime);
const repo = 'owner/repo';

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

beforeEach(() => {
  mockGh.mockReset();
  mockSelectIssuesForStage.mockReset();
  mockSelectIssuesForStage.mockResolvedValue([]);
  mockClearStaleLockIfNeeded.mockReset();
  mockFetchIssueTimelines.mockReset();
  mockFetchIssueTimelines.mockResolvedValue(new Map());
  mockSortIssuesByLabelTime.mockReset();
  mockSortIssuesByLabelTime.mockImplementation(<T>(issues: T[]) => issues);
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('AUTO_PRIORITY_LABELS', () => {
  it('contains the 7 expected auto-ship labels in priority order', () => {
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
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:ready') return [];
      if (label === 'shipper:pr-reviewed') return [];
      if (label === 'shipper:pr-open') return [{ number: 10, title: 'PR open issue', priority: 1 }];
      if (label === 'shipper:groomed') return [{ number: 20, title: 'Groomed issue', priority: 1 }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 10, title: 'PR open issue' });
    expect(mockSelectIssuesForStage).toHaveBeenCalledWith(
      repo,
      'shipper:ready',
      expect.any(Set),
      expect.objectContaining({ skipTimeline: true })
    );
  });

  it('skips issues in the skippedIssues set', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:pr-open') {
        return [
          { number: 10, title: 'Skipped issue', priority: 1 },
          { number: 11, title: 'Next issue', priority: 1 },
        ];
      }
      return [];
    });

    const result = await selectNextCandidate(repo, new Set([10]));
    expect(result).toEqual({ number: 11, title: 'Next issue' });
  });

  it('returns null when no candidates remain', async () => {
    mockSelectIssuesForStage.mockResolvedValue([]);

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toBeNull();
  });

  it('returns null when all candidates are skipped', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return [{ number: 5, title: 'Only issue', priority: 1 }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set([5]));
    expect(result).toBeNull();
  });

  it('never queries shipper:new when auto-selecting the next candidate', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:groomed') {
        return [{ number: 20, title: 'Eligible issue', priority: 1 }];
      }

      if (label === 'shipper:new') {
        return [{ number: 10, title: 'New issue', priority: 1 }];
      }

      return [];
    });

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 20, title: 'Eligible issue' });
    expect(mockSelectIssuesForStage).not.toHaveBeenCalledWith(
      repo,
      'shipper:new',
      expect.any(Set),
      expect.objectContaining({ skipTimeline: true })
    );
  });

  it('returns null when shipper:new is the only workflow issue', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:new') {
        return [{ number: 10, title: 'New issue', priority: 1 }];
      }

      return [];
    });

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toBeNull();
    expect(mockSelectIssuesForStage).not.toHaveBeenCalledWith(
      repo,
      'shipper:new',
      expect.any(Set),
      expect.objectContaining({ skipTimeline: true })
    );
  });

  it('does not fetch timelines when only one candidate exists across all stages', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:groomed') return [{ number: 1, title: 'Only issue', priority: 1 }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 1, title: 'Only issue' });
    expect(mockFetchIssueTimelines).not.toHaveBeenCalled();
    expect(mockSortIssuesByLabelTime).not.toHaveBeenCalled();
  });

  it('does not fetch timelines when the winning bucket has a single candidate', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:pr-open') {
        return [{ number: 30, title: 'PR open issue', priority: 1 }];
      }

      if (label === 'shipper:groomed') {
        return [
          { number: 40, title: 'High groomed issue', priority: 0 },
          { number: 41, title: 'Normal groomed issue', priority: 1 },
        ];
      }

      return [];
    });

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 40, title: 'High groomed issue' });
    expect(mockFetchIssueTimelines).not.toHaveBeenCalled();
    expect(mockSortIssuesByLabelTime).not.toHaveBeenCalled();
  });

  it('fetches timelines only for the winning bucket when tie-breaking is needed', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:pr-open') {
        return [{ number: 30, title: 'Non-winning issue', priority: 2 }];
      }

      if (label === 'shipper:groomed') {
        return [
          { number: 1, title: 'Oldest', priority: 1 },
          { number: 2, title: 'Newer', priority: 1 },
        ];
      }

      return [];
    });
    mockFetchIssueTimelines.mockResolvedValue(
      new Map([
        [1, [{ created_at: '2025-01-01T00:00:00Z' }]],
        [2, [{ created_at: '2025-01-02T00:00:00Z' }]],
      ])
    );
    mockSortIssuesByLabelTime.mockImplementation((issues) => issues.slice().reverse());

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 2, title: 'Newer' });
    expect(mockFetchIssueTimelines).toHaveBeenCalledTimes(1);
    expect(mockFetchIssueTimelines).toHaveBeenCalledWith(repo, [1, 2]);
    expect(mockSortIssuesByLabelTime).toHaveBeenCalledWith(
      [
        { number: 1, title: 'Oldest', priority: 1 },
        { number: 2, title: 'Newer', priority: 1 },
      ],
      expect.any(Map),
      'shipper:groomed'
    );
  });

  it('clears stale lock on selected candidate', async () => {
    mockSelectIssuesForStage.mockImplementation(
      (_repo: string, label: string, staleLocked?: Set<number>) => {
        if (label === 'shipper:planned') {
          const issues = [{ number: 7, title: 'Stale locked issue', priority: 1 as const }];
          staleLocked?.add(7);
          return Promise.resolve(issues);
        }
        return Promise.resolve([]);
      }
    );

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 7, title: 'Stale locked issue' });
    expect(mockClearStaleLockIfNeeded).toHaveBeenCalledWith(repo, 7, expect.any(Set));
  });

  it('calls clearStaleLockIfNeeded with empty staleLocked set for non-stale candidate', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') return [{ number: 7, title: 'Normal issue', priority: 1 }];
      return [];
    });

    const result = await selectNextCandidate(repo, new Set());
    expect(result).toEqual({ number: 7, title: 'Normal issue' });
    expect(mockClearStaleLockIfNeeded).toHaveBeenCalledWith(repo, 7, new Set());
  });

  it('skips issues already active in parallel slots', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:planned') {
        return [
          { number: 7, title: 'Active issue', priority: 1 },
          { number: 8, title: 'Available issue', priority: 1 },
        ];
      }
      return [];
    });

    const result = await selectNextCandidate(repo, new Set(), new Set([7]));
    expect(result).toEqual({ number: 8, title: 'Available issue' });
  });

  it('prefers higher-priority issues over more advanced normal-priority issues', async () => {
    mockSelectIssuesForStage.mockImplementation((_repo: string, label: string) => {
      if (label === 'shipper:pr-open') {
        return [{ number: 30, title: 'Normal PR open issue', priority: 1 }];
      }

      if (label === 'shipper:groomed') {
        return [{ number: 40, title: 'High groomed issue', priority: 0 }];
      }

      return [];
    });

    const result = await selectNextCandidate(repo, new Set());

    expect(result).toEqual({ number: 40, title: 'High groomed issue' });
    expect(mockFetchIssueTimelines).not.toHaveBeenCalled();
  });
});

describe('selectBlockedIssues', () => {
  it('returns empty array when no blocked issues exist', async () => {
    mockGh.mockResolvedValue({ stdout: '[]', stderr: '' });
    const result = await selectBlockedIssues(repo);
    expect(result).toEqual([]);
  });

  it('returns issues sorted by stage priority', async () => {
    const issues = [
      {
        number: 10,
        title: 'New issue',
        labels: [{ name: 'shipper:new' }, { name: 'shipper:blocked' }],
      },
      {
        number: 20,
        title: 'PR reviewed issue',
        labels: [{ name: 'shipper:pr-reviewed' }, { name: 'shipper:blocked' }],
      },
      {
        number: 30,
        title: 'Planned issue',
        labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
      },
    ];
    mockGh.mockResolvedValue({ stdout: JSON.stringify(issues), stderr: '' });

    const result = await selectBlockedIssues(repo);
    expect(result).toEqual([
      { number: 20, title: 'PR reviewed issue' },
      { number: 30, title: 'Planned issue' },
      { number: 10, title: 'New issue' },
    ]);
  });

  it('returns empty array when gh throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockGh.mockRejectedValue(new Error('gh CLI error'));
      const result = await selectBlockedIssues(repo);
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(prefixed('Failed to fetch blocked issues'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns empty array and warns when the blocked issues response is invalid JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockGh.mockResolvedValue({ stdout: '{not json', stderr: '' });

      const result = await selectBlockedIssues(repo);

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(prefixed('Failed to parse blocked issues response'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('passes --search flag to exclude shipper:locked issues', async () => {
    mockGh.mockResolvedValue({ stdout: '[]', stderr: '' });
    await selectBlockedIssues(repo);
    expect(mockGh).toHaveBeenCalledWith(
      expect.arrayContaining(['-R', repo, '--search', '-label:shipper:locked'])
    );
  });

  it('sorts issues with no recognized stage label to the end', async () => {
    const issues = [
      {
        number: 10,
        title: 'No stage label',
        labels: [{ name: 'shipper:blocked' }, { name: 'bug' }],
      },
      {
        number: 20,
        title: 'Groomed issue',
        labels: [{ name: 'shipper:groomed' }, { name: 'shipper:blocked' }],
      },
    ];
    mockGh.mockResolvedValue({ stdout: JSON.stringify(issues), stderr: '' });

    const result = await selectBlockedIssues(repo);
    expect(result).toEqual([
      { number: 20, title: 'Groomed issue' },
      { number: 10, title: 'No stage label' },
    ]);
  });
});

describe('printUnblockSummary', () => {
  it('prints one final outcome row per issue in final-attempt order while preserving every unblock log file', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
    const singleAttemptIssueRows = entries.filter((entry) => entry.includes('Add OAuth provider'));

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

    logSpy.mockRestore();
  });

  it('prints one still-blocked outcome row when the same issue remains blocked across attempts', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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

    logSpy.mockRestore();
  });

  it('truncates long titles to 42 chars + ellipsis', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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

    logSpy.mockRestore();
  });

  it('does not print unblock log files section when no attempts have log files', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const attempts: UnblockAttempt[] = [
      { issue: 5, title: 'Legacy attempt', outcome: 'unblocked' },
    ];

    printUnblockSummary(attempts);

    const output = getConsoleOutput(logSpy);
    expect(output).not.toContain('Unblock log files:');

    logSpy.mockRestore();
  });
});
