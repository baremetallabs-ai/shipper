import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import {
  formatIssue,
  formatPR,
  sortIssuesByLabelTime,
  tryResolvePrForIssue,
  type TimelineLabelEvent,
} from '../../src/lib/github.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, execFileSync: vi.fn() };
});

describe('formatIssue', () => {
  it('formats a basic issue with comments', () => {
    const result = formatIssue({
      number: 42,
      title: 'Fix login bug',
      state: 'OPEN',
      labels: [{ name: 'bug' }, { name: 'shipper:groomed' }],
      body: 'Login fails on Safari.',
      comments: [
        {
          author: { login: 'alice' },
          body: 'Can reproduce on iOS too.',
          createdAt: '2025-01-15T10:30:00Z',
        },
      ],
      author: { login: 'bob' },
      createdAt: '2025-01-14T08:00:00Z',
    });

    expect(result).toContain('# Issue #42: Fix login bug');
    expect(result).toContain('**State:** OPEN');
    expect(result).toContain('bug, shipper:groomed');
    expect(result).toContain('@bob');
    expect(result).toContain('Login fails on Safari.');
    expect(result).toContain('## Comments');
    expect(result).toContain('@alice');
    expect(result).toContain('Can reproduce on iOS too.');
  });

  it('formats an issue with no comments', () => {
    const result = formatIssue({
      number: 1,
      title: 'Add feature',
      state: 'OPEN',
      labels: [],
      body: 'We need this.',
      comments: [],
      author: { login: 'dan' },
      createdAt: '2025-01-01T00:00:00Z',
    });

    expect(result).toContain('# Issue #1: Add feature');
    expect(result).toContain('**Labels:** none');
    expect(result).not.toContain('## Comments');
  });

  it('handles missing body', () => {
    const result = formatIssue({
      number: 5,
      title: 'Empty',
      state: 'CLOSED',
      labels: [],
      body: '',
      comments: [],
      author: { login: 'x' },
      createdAt: '2025-01-01T00:00:00Z',
    });

    expect(result).toContain('*No description provided.*');
  });
});

describe('formatPR', () => {
  it('formats a PR with reviews and comments', () => {
    const result = formatPR({
      number: 10,
      title: 'Fix the thing',
      state: 'OPEN',
      labels: [{ name: 'enhancement' }],
      body: 'This fixes the thing.',
      comments: [
        {
          author: { login: 'reviewer' },
          body: 'Looks good overall.',
          createdAt: '2025-02-01T12:00:00Z',
        },
      ],
      author: { login: 'dev' },
      createdAt: '2025-01-30T09:00:00Z',
      headRefName: 'fix/thing',
      baseRefName: 'main',
      reviews: [
        {
          author: { login: 'reviewer' },
          body: 'Approved with minor notes.',
          state: 'APPROVED',
          submittedAt: '2025-02-01T11:00:00Z',
        },
      ],
    });

    expect(result).toContain('# PR #10: Fix the thing');
    expect(result).toContain('**Branch:** fix/thing → main');
    expect(result).toContain('## Reviews');
    expect(result).toContain('APPROVED');
    expect(result).toContain('Approved with minor notes.');
    expect(result).toContain('## Comments');
    expect(result).toContain('Looks good overall.');
  });

  it('formats a PR with no reviews or comments', () => {
    const result = formatPR({
      number: 3,
      title: 'Simple change',
      state: 'OPEN',
      labels: [],
      body: 'Just a small fix.',
      comments: [],
      author: { login: 'dev' },
      createdAt: '2025-01-01T00:00:00Z',
      headRefName: 'patch-1',
      baseRefName: 'main',
      reviews: [],
    });

    expect(result).toContain('# PR #3: Simple change');
    expect(result).toContain('**Branch:** patch-1 → main');
    expect(result).not.toContain('## Reviews');
    expect(result).not.toContain('## Comments');
  });
});

describe('sortIssuesByLabelTime', () => {
  const label = 'shipper:new';

  it('returns empty array for empty input', () => {
    const result = sortIssuesByLabelTime([], new Map(), label);
    expect(result).toEqual([]);
  });

  it('returns single issue as-is', () => {
    const issues = [{ number: 1, title: 'First' }];
    const timelines = new Map<number, TimelineLabelEvent[]>();
    timelines.set(1, [
      { event: 'labeled', label: { name: label }, created_at: '2025-01-01T00:00:00Z' },
    ]);
    const result = sortIssuesByLabelTime(issues, timelines, label);
    expect(result).toEqual([{ number: 1, title: 'First' }]);
  });

  it('sorts multiple issues by label timestamp oldest first', () => {
    const issues = [
      { number: 2, title: 'Second' },
      { number: 1, title: 'First' },
      { number: 3, title: 'Third' },
    ];
    const timelines = new Map<number, TimelineLabelEvent[]>();
    timelines.set(2, [
      { event: 'labeled', label: { name: label }, created_at: '2025-01-02T00:00:00Z' },
    ]);
    timelines.set(1, [
      { event: 'labeled', label: { name: label }, created_at: '2025-01-01T00:00:00Z' },
    ]);
    timelines.set(3, [
      { event: 'labeled', label: { name: label }, created_at: '2025-01-03T00:00:00Z' },
    ]);
    const result = sortIssuesByLabelTime(issues, timelines, label);
    expect(result).toEqual([
      { number: 1, title: 'First' },
      { number: 2, title: 'Second' },
      { number: 3, title: 'Third' },
    ]);
  });

  it('uses last label event when label was applied multiple times', () => {
    const issues = [
      { number: 1, title: 'Reset issue' },
      { number: 2, title: 'Normal issue' },
    ];
    const timelines = new Map<number, TimelineLabelEvent[]>();
    timelines.set(1, [
      { event: 'labeled', label: { name: label }, created_at: '2025-01-01T00:00:00Z' },
      { event: 'unlabeled', label: { name: label }, created_at: '2025-01-02T00:00:00Z' },
      { event: 'labeled', label: { name: label }, created_at: '2025-01-05T00:00:00Z' },
    ]);
    timelines.set(2, [
      { event: 'labeled', label: { name: label }, created_at: '2025-01-03T00:00:00Z' },
    ]);
    const result = sortIssuesByLabelTime(issues, timelines, label);
    expect(result).toEqual([
      { number: 2, title: 'Normal issue' },
      { number: 1, title: 'Reset issue' },
    ]);
  });

  it('sorts issues with no matching label event to the end', () => {
    const issues = [
      { number: 1, title: 'No events' },
      { number: 2, title: 'Has events' },
    ];
    const timelines = new Map<number, TimelineLabelEvent[]>();
    timelines.set(1, []);
    timelines.set(2, [
      { event: 'labeled', label: { name: label }, created_at: '2025-01-01T00:00:00Z' },
    ]);
    const result = sortIssuesByLabelTime(issues, timelines, label);
    expect(result).toEqual([
      { number: 2, title: 'Has events' },
      { number: 1, title: 'No events' },
    ]);
  });
});

describe('tryResolvePrForIssue', () => {
  let execFileSync: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const cp = await import('node:child_process');
    execFileSync = vi.mocked(cp.execFileSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches exact branch shipper/12', () => {
    execFileSync.mockReturnValueOnce(
      JSON.stringify([{ number: 99, headRefName: 'shipper/12' }])
    );
    expect(tryResolvePrForIssue(12)).toBe('99');
  });

  it('matches prefixed branch shipper/12-some-slug', () => {
    execFileSync.mockReturnValueOnce(
      JSON.stringify([{ number: 50, headRefName: 'shipper/12-some-slug' }])
    );
    expect(tryResolvePrForIssue(12)).toBe('50');
  });

  it('does NOT match unrelated branch containing the number', () => {
    execFileSync.mockReturnValueOnce(
      JSON.stringify([{ number: 77, headRefName: 'fix/update-12-deps' }])
    );
    expect(tryResolvePrForIssue(12)).toBeUndefined();
  });

  it('does NOT match partial prefix shipper/123 when searching for 12', () => {
    execFileSync.mockReturnValueOnce(
      JSON.stringify([{ number: 88, headRefName: 'shipper/123' }])
    );
    expect(tryResolvePrForIssue(12)).toBeUndefined();
  });

  it('returns undefined when no PRs exist', () => {
    execFileSync.mockReturnValueOnce(JSON.stringify([]));
    expect(tryResolvePrForIssue(12)).toBeUndefined();
  });

  it('returns undefined when gh command fails', () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error('gh failed');
    });
    expect(tryResolvePrForIssue(12)).toBeUndefined();
  });
});
