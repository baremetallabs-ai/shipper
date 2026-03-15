import { promisify } from 'node:util';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const execFileMock = vi.fn();
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const execFile = Object.assign(
  (...args: unknown[]) => {
    execFileMock(...args);
  },
  {
    [promisify.custom]: (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFileMock(
          ...args,
          (err: unknown, stdout: string | Buffer = '', stderr: string | Buffer = '') => {
            if (err) {
              reject(normalizeError(err));
              return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        );
      }),
  }
);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile,
  };
});

vi.mock('../../src/lib/lock.js', () => ({
  isLockStale: vi.fn(() => Promise.resolve(false)),
  releaseIssueLock: vi.fn(() => Promise.resolve()),
}));

function queueExecFileResult(stdout: string): void {
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
    cb(null, stdout, '');
  });
}

function queueExecFileError(message: string): void {
  execFileMock.mockImplementationOnce((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
    cb(Object.assign(new Error(message), { stderr: 'not found' }));
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (...cbArgs: unknown[]) => void;
    cb(null, '', '');
  });
});

const {
  autoSelectIssue,
  fetchPR,
  formatIssue,
  formatPR,
  listIssues,
  resolveBaseBranch,
  selectIssuesForStage,
  sortIssuesByLabelTime,
  tryResolvePrForIssue,
} = await import('../../src/lib/github.js');
type TimelineLabelEvent = import('../../src/lib/github.js').TimelineLabelEvent;
type FormatPRInput = Parameters<typeof formatPR>[0];
const repo = 'owner/repo';

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

    expect(result).toContain(
      '<issue number="42" title="Fix login bug" state="OPEN" labels="bug, shipper:groomed" author="bob" created="2025-01-14T08:00:00Z">'
    );
    expect(result).toContain('<body>\nLogin fails on Safari.\n</body>');
    expect(result).toContain('<comments>');
    expect(result).toContain(
      '<comment author="alice" date="2025-01-15T10:30:00Z">\nCan reproduce on iOS too.\n</comment>'
    );
    expect(result).toContain('</issue>');
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

    expect(result).toContain('<issue number="1" title="Add feature"');
    expect(result).toContain('labels="none"');
    expect(result).not.toContain('<comments>');
    expect(result).toContain('</issue>');
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

    expect(result).toContain('<body />');
    expect(result).not.toContain('*No description provided.*');
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

    expect(result).toContain(
      '<pr number="10" title="Fix the thing" state="OPEN" labels="enhancement" author="dev" created="2025-01-30T09:00:00Z" head="fix/thing" base="main">'
    );
    expect(result).toContain('<body>\nThis fixes the thing.\n</body>');
    expect(result).toContain('<reviews>');
    expect(result).toContain(
      '<review author="reviewer" state="APPROVED" date="2025-02-01T11:00:00Z">\nApproved with minor notes.\n</review>'
    );
    expect(result).toContain('<comments>');
    expect(result).toContain(
      '<comment author="reviewer" date="2025-02-01T12:00:00Z">\nLooks good overall.\n</comment>'
    );
    expect(result).toContain('</pr>');
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

    expect(result).toContain('<pr number="3" title="Simple change"');
    expect(result).toContain('head="patch-1" base="main"');
    expect(result).not.toContain('<reviews>');
    expect(result).not.toContain('<comments>');
    expect(result).toContain('</pr>');
  });

  it('formats a PR review with an empty body without placeholder text', () => {
    const result = formatPR({
      number: 4,
      title: 'Empty review body',
      state: 'OPEN',
      labels: [],
      body: 'Please review.',
      comments: [],
      author: { login: 'dev' },
      createdAt: '2025-01-02T00:00:00Z',
      headRefName: 'feature-empty-review',
      baseRefName: 'main',
      reviews: [
        {
          body: '',
          author: { login: 'reviewer' },
          state: 'APPROVED',
          submittedAt: '2025-01-02T01:00:00Z',
        },
      ],
    } as unknown as FormatPRInput);

    expect(result).toContain('<review author="reviewer" state="APPROVED"');
    expect(result).toContain('></review>');
    expect(result).not.toContain('*No review body.*');
  });

  it('escapes special characters in title and labels', () => {
    const result = formatPR({
      number: 5,
      title: 'Fix "login" & <session> bug',
      state: 'OPEN',
      labels: [{ name: 'P0 & critical' }, { name: '"urgent"' }],
      body: 'Body with <html> & "quotes".',
      comments: [],
      author: { login: 'dev' },
      createdAt: '2025-01-01T00:00:00Z',
      headRefName: 'fix/login&session',
      baseRefName: 'main',
      reviews: [],
    } as unknown as FormatPRInput);

    expect(result).toContain('title="Fix &quot;login&quot; &amp; &lt;session&gt; bug"');
    expect(result).toContain('labels="P0 &amp; critical, &quot;urgent&quot;"');
    expect(result).toContain('head="fix/login&amp;session"');
    expect(result).toContain('<body>\nBody with <html> & "quotes".\n</body>');
  });

  it('renders pending reviews with an empty date attribute', () => {
    const result = formatPR({
      number: 6,
      title: 'Pending review',
      state: 'OPEN',
      labels: [],
      body: 'Waiting on review.',
      comments: [],
      author: { login: 'dev' },
      createdAt: '2025-01-01T00:00:00Z',
      headRefName: 'feature/pending-review',
      baseRefName: 'main',
      reviews: [
        {
          author: { login: 'reviewer' },
          body: '',
          state: 'PENDING',
          submittedAt: null,
        },
      ],
    } as unknown as FormatPRInput);

    expect(result).toContain('<review author="reviewer" state="PENDING" date=""></review>');
  });
});

describe('fetchPR', () => {
  it('accepts pending reviews with a null submittedAt timestamp', async () => {
    queueExecFileResult(
      JSON.stringify({
        number: 10,
        title: 'Fix the thing',
        state: 'OPEN',
        labels: [{ name: 'shipper:pr-open' }],
        body: 'This fixes the thing.',
        comments: [],
        author: { login: 'dev' },
        createdAt: '2025-01-30T09:00:00Z',
        headRefName: 'fix/thing',
        baseRefName: 'main',
        reviews: [
          {
            author: { login: 'reviewer' },
            body: '',
            state: 'PENDING',
            submittedAt: null,
          },
        ],
      })
    );

    await expect(fetchPR(repo, '10')).resolves.toContain(
      '<review author="reviewer" state="PENDING" date=""></review>'
    );
  });
});

describe('formatIssue escapeAttr', () => {
  it('escapes special characters in title and labels', () => {
    const result = formatIssue({
      number: 6,
      title: 'Handle <script> & "injection"',
      state: 'OPEN',
      labels: [{ name: 'bug & fix' }],
      body: 'Content with <tags> & "quotes".',
      comments: [],
      author: { login: 'user' },
      createdAt: '2025-01-01T00:00:00Z',
    });

    expect(result).toContain('title="Handle &lt;script&gt; &amp; &quot;injection&quot;"');
    expect(result).toContain('labels="bug &amp; fix"');
    expect(result).toContain('<body>\nContent with <tags> & "quotes".\n</body>');
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches exact branch shipper/12', async () => {
    queueExecFileResult(JSON.stringify([{ number: 99, headRefName: 'shipper/12' }]));
    expect(await tryResolvePrForIssue(repo, 12)).toBe('99');
  });

  it('matches prefixed branch shipper/12-some-slug', async () => {
    queueExecFileResult(JSON.stringify([{ number: 50, headRefName: 'shipper/12-some-slug' }]));
    expect(await tryResolvePrForIssue(repo, 12)).toBe('50');
  });

  it('does NOT match unrelated branch containing the number', async () => {
    queueExecFileResult(JSON.stringify([{ number: 77, headRefName: 'fix/update-12-deps' }]));
    expect(await tryResolvePrForIssue(repo, 12)).toBeUndefined();
  });

  it('does NOT match partial prefix shipper/123 when searching for 12', async () => {
    queueExecFileResult(JSON.stringify([{ number: 88, headRefName: 'shipper/123' }]));
    expect(await tryResolvePrForIssue(repo, 12)).toBeUndefined();
  });

  it('returns undefined when no PRs exist', async () => {
    queueExecFileResult(JSON.stringify([]));
    expect(await tryResolvePrForIssue(repo, 12)).toBeUndefined();
  });

  it('returns undefined when gh command fails', async () => {
    queueExecFileError('gh failed');
    expect(await tryResolvePrForIssue(repo, 12)).toBeUndefined();
  });
});

describe('resolveBaseBranch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns configured value when branch exists on remote', async () => {
    queueExecFileResult('abc123\trefs/heads/develop\n');
    expect(await resolveBaseBranch(repo, 'develop')).toBe('develop');
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--heads', 'origin', 'develop'],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
  });

  it('throws when configured branch does not exist on remote', async () => {
    queueExecFileResult('');
    await expect(resolveBaseBranch(repo, 'nonexistent')).rejects.toThrow(
      "configured defaultBaseBranch 'nonexistent' does not exist on remote."
    );
  });

  it('auto-detects via gh repo view when no value configured', async () => {
    queueExecFileResult('main\n');
    expect(await resolveBaseBranch(repo)).toBe('main');
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
  });

  it('auto-detects non-main default branches', async () => {
    queueExecFileResult('master\n');
    expect(await resolveBaseBranch(repo, undefined)).toBe('master');
  });
});

describe('selectIssuesForStage', () => {
  let mockIsLockStale: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const lock = await import('../../src/lib/lock.js');
    mockIsLockStale = vi.mocked(lock.isLockStale);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes stale-locked issues in results', async () => {
    // First call: normal issues query
    queueExecFileResult(
      JSON.stringify([{ number: 1, title: 'Normal', labels: [{ name: 'shipper:new' }] }])
    );
    // Second call: locked issues query
    queueExecFileResult(
      JSON.stringify([
        {
          number: 2,
          title: 'Stale locked',
          labels: [{ name: 'shipper:new' }, { name: 'shipper:locked' }],
        },
      ])
    );
    mockIsLockStale.mockResolvedValueOnce(true);
    // Third + fourth calls: timeline for each issue
    queueExecFileResult('');
    queueExecFileResult('');

    const staleLocked = new Set<number>();
    const result = await selectIssuesForStage(repo, 'shipper:new', staleLocked);

    expect(result).toEqual(
      expect.arrayContaining([
        { number: 1, title: 'Normal', priority: 1 },
        { number: 2, title: 'Stale locked', priority: 1 },
      ])
    );
    expect(staleLocked.has(2)).toBe(true);
    expect(staleLocked.has(1)).toBe(false);
  });

  it('excludes actively-locked issues', async () => {
    queueExecFileResult(
      JSON.stringify([{ number: 1, title: 'Normal', labels: [{ name: 'shipper:new' }] }])
    );
    queueExecFileResult(
      JSON.stringify([
        {
          number: 2,
          title: 'Active locked',
          labels: [{ name: 'shipper:new' }, { name: 'shipper:locked' }],
        },
      ])
    );
    mockIsLockStale.mockResolvedValueOnce(false);

    const staleLocked = new Set<number>();
    const result = await selectIssuesForStage(repo, 'shipper:new', staleLocked);

    expect(result).toEqual([{ number: 1, title: 'Normal', priority: 1 }]);
    expect(staleLocked.size).toBe(0);
  });

  it('works when no locked issues exist', async () => {
    queueExecFileResult(
      JSON.stringify([{ number: 1, title: 'Normal', labels: [{ name: 'shipper:new' }] }])
    );
    queueExecFileResult(JSON.stringify([]));

    const result = await selectIssuesForStage(repo, 'shipper:new');

    expect(result).toEqual([{ number: 1, title: 'Normal', priority: 1 }]);
  });

  it('works without staleLocked parameter', async () => {
    queueExecFileResult(
      JSON.stringify([{ number: 1, title: 'Normal', labels: [{ name: 'shipper:new' }] }])
    );
    queueExecFileResult(
      JSON.stringify([
        {
          number: 2,
          title: 'Stale locked',
          labels: [{ name: 'shipper:new' }, { name: 'shipper:locked' }],
        },
      ])
    );
    mockIsLockStale.mockResolvedValueOnce(true);
    // timelines (2 issues triggers sorting path)
    queueExecFileResult('');
    queueExecFileResult('');

    const result = await selectIssuesForStage(repo, 'shipper:new');

    expect(result).toEqual(
      expect.arrayContaining([
        { number: 1, title: 'Normal', priority: 1 },
        { number: 2, title: 'Stale locked', priority: 1 },
      ])
    );
  });

  it('omits blocked exclusion from both queries for shipper:new', async () => {
    queueExecFileResult(JSON.stringify([]));
    queueExecFileResult(JSON.stringify([]));

    await selectIssuesForStage(repo, 'shipper:new');

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      [
        'issue',
        'list',
        '-R',
        repo,
        '--label',
        'shipper:new',
        '--state',
        'open',
        '--limit',
        '1000',
        '--search',
        '-label:shipper:locked -label:shipper:failed',
        '--json',
        'number,title,labels',
      ],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      [
        'issue',
        'list',
        '-R',
        repo,
        '--label',
        'shipper:new',
        '--label',
        'shipper:locked',
        '--state',
        'open',
        '--limit',
        '1000',
        '--search',
        '-label:shipper:failed',
        '--json',
        'number,title,labels',
      ],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
  });

  it('keeps blocked exclusion in both queries for later stages', async () => {
    queueExecFileResult(JSON.stringify([]));
    queueExecFileResult(JSON.stringify([]));

    await selectIssuesForStage(repo, 'shipper:groomed');

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      [
        'issue',
        'list',
        '-R',
        repo,
        '--label',
        'shipper:groomed',
        '--state',
        'open',
        '--limit',
        '1000',
        '--search',
        '-label:shipper:blocked -label:shipper:locked -label:shipper:failed',
        '--json',
        'number,title,labels',
      ],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      [
        'issue',
        'list',
        '-R',
        repo,
        '--label',
        'shipper:groomed',
        '--label',
        'shipper:locked',
        '--state',
        'open',
        '--limit',
        '1000',
        '--search',
        '-label:shipper:blocked -label:shipper:failed',
        '--json',
        'number,title,labels',
      ],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
  });

  it('handles locked issues query failure gracefully', async () => {
    queueExecFileResult(
      JSON.stringify([{ number: 1, title: 'Normal', labels: [{ name: 'shipper:new' }] }])
    );
    queueExecFileError('gh failed');
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await selectIssuesForStage(repo, 'shipper:new');

    expect(result).toEqual([{ number: 1, title: 'Normal', priority: 1 }]);
    expect(stderrSpy).toHaveBeenCalledWith(
      'Warning: Could not check for stale-locked issues. Proceeding without them.'
    );
    stderrSpy.mockRestore();
  });

  it('sorts issues by priority tier before FIFO within the same stage', async () => {
    queueExecFileResult(
      JSON.stringify([
        {
          number: 30,
          title: 'Low oldest',
          labels: [{ name: 'shipper:new' }, { name: 'shipper:priority-low' }],
        },
        {
          number: 20,
          title: 'Normal oldest',
          labels: [{ name: 'shipper:new' }],
        },
        {
          number: 10,
          title: 'High newest',
          labels: [{ name: 'shipper:new' }, { name: 'shipper:priority-high' }],
        },
        {
          number: 40,
          title: 'High oldest',
          labels: [{ name: 'shipper:new' }, { name: 'shipper:priority-high' }],
        },
      ])
    );
    queueExecFileResult(JSON.stringify([]));
    queueExecFileResult(
      JSON.stringify({
        event: 'labeled',
        label: { name: 'shipper:new' },
        created_at: '2025-01-04T00:00:00Z',
      })
    );
    queueExecFileResult(
      JSON.stringify({
        event: 'labeled',
        label: { name: 'shipper:new' },
        created_at: '2025-01-02T00:00:00Z',
      })
    );
    queueExecFileResult(
      JSON.stringify({
        event: 'labeled',
        label: { name: 'shipper:new' },
        created_at: '2025-01-03T00:00:00Z',
      })
    );
    queueExecFileResult(
      JSON.stringify({
        event: 'labeled',
        label: { name: 'shipper:new' },
        created_at: '2025-01-01T00:00:00Z',
      })
    );

    const result = await selectIssuesForStage(repo, 'shipper:new');

    expect(result).toEqual([
      { number: 40, title: 'High oldest', priority: 0 },
      { number: 10, title: 'High newest', priority: 0 },
      { number: 20, title: 'Normal oldest', priority: 1 },
      { number: 30, title: 'Low oldest', priority: 2 },
    ]);
  });
});

describe('autoSelectIssue', () => {
  let mockIsLockStale: ReturnType<typeof vi.fn>;
  let mockReleaseIssueLock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const lock = await import('../../src/lib/lock.js');
    mockIsLockStale = vi.mocked(lock.isLockStale);
    mockReleaseIssueLock = vi.mocked(lock.releaseIssueLock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears stale lock on selected issue and prints message', async () => {
    queueExecFileResult(JSON.stringify([]));
    queueExecFileResult(
      JSON.stringify([
        {
          number: 42,
          title: 'Stale issue',
          labels: [{ name: 'shipper:new' }, { name: 'shipper:locked' }],
        },
      ])
    );
    mockIsLockStale.mockResolvedValueOnce(true);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await autoSelectIssue(repo, 'shipper:new');

    expect(result).toEqual({ number: 42, title: 'Stale issue' });
    expect(mockReleaseIssueLock).toHaveBeenCalledWith(repo, '42');
    expect(stderrSpy).toHaveBeenCalledWith('Issue #42 lock is stale \u2014 clearing.');
  });

  it('does not clear lock for non-stale selected issue', async () => {
    queueExecFileResult(
      JSON.stringify([{ number: 10, title: 'Normal issue', labels: [{ name: 'shipper:new' }] }])
    );
    queueExecFileResult(JSON.stringify([]));

    const result = await autoSelectIssue(repo, 'shipper:new');

    expect(result).toEqual({ number: 10, title: 'Normal issue' });
    expect(mockReleaseIssueLock).not.toHaveBeenCalled();
  });

  it('returns null when no candidates exist', async () => {
    queueExecFileResult(JSON.stringify([]));
    queueExecFileResult(JSON.stringify([]));

    const result = await autoSelectIssue(repo, 'shipper:new');

    expect(result).toBeNull();
    expect(mockReleaseIssueLock).not.toHaveBeenCalled();
  });

  it('selects blocked and non-blocked shipper:new candidates from one time-ordered pool', async () => {
    queueExecFileResult(
      JSON.stringify([
        {
          number: 20,
          title: 'Blocked issue',
          labels: [{ name: 'shipper:new' }, { name: 'shipper:blocked' }],
        },
        { number: 10, title: 'Normal issue', labels: [{ name: 'shipper:new' }] },
      ])
    );
    queueExecFileResult(JSON.stringify([]));
    queueExecFileResult(
      JSON.stringify({
        event: 'labeled',
        label: { name: 'shipper:new' },
        created_at: '2025-01-02T00:00:00Z',
      })
    );
    queueExecFileResult(
      JSON.stringify({
        event: 'labeled',
        label: { name: 'shipper:new' },
        created_at: '2025-01-01T00:00:00Z',
      })
    );

    const result = await autoSelectIssue(repo, 'shipper:new');

    expect(result).toEqual({ number: 10, title: 'Normal issue' });
  });
});

describe('listIssues', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns flattened issue objects for shipper-labeled issues', async () => {
    const ghOutput = [
      {
        number: 1,
        title: 'First issue',
        labels: [{ name: 'shipper:groomed' }, { name: 'bug' }],
        state: 'OPEN',
        author: { login: 'alice' },
        createdAt: '2025-01-01T00:00:00Z',
      },
      {
        number: 2,
        title: 'Second issue',
        labels: [{ name: 'shipper:planned' }],
        state: 'OPEN',
        author: { login: 'bob' },
        createdAt: '2025-01-02T00:00:00Z',
      },
      {
        number: 3,
        title: 'Non-shipper issue',
        labels: [{ name: 'bug' }],
        state: 'OPEN',
        author: { login: 'charlie' },
        createdAt: '2025-01-03T00:00:00Z',
      },
    ];
    queueExecFileResult(JSON.stringify(ghOutput));

    const result = await listIssues(repo);

    expect(result).toEqual([
      {
        number: 1,
        title: 'First issue',
        labels: ['shipper:groomed', 'bug'],
        state: 'OPEN',
        author: 'alice',
        createdAt: '2025-01-01T00:00:00Z',
      },
      {
        number: 2,
        title: 'Second issue',
        labels: ['shipper:planned'],
        state: 'OPEN',
        author: 'bob',
        createdAt: '2025-01-02T00:00:00Z',
      },
    ]);
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      [
        'issue',
        'list',
        '-R',
        repo,
        '--json',
        'number,title,labels,state,author,createdAt',
        '--limit',
        '1000',
        '--state',
        'open',
      ],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
  });

  it('returns empty array when no issues found', async () => {
    queueExecFileResult('[]');

    const result = await listIssues(repo);

    expect(result).toEqual([]);
  });

  it('throws with context message on gh failure', async () => {
    queueExecFileError('gh failed');
    queueExecFileError('gh failed');
    queueExecFileError('gh failed');

    await expect(listIssues(repo)).rejects.toThrow('Failed to list issues for owner/repo');
  });

  it('passes --label when label option is provided', async () => {
    queueExecFileResult('[]');

    await listIssues(repo, { label: 'shipper:planned' });

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      [
        'issue',
        'list',
        '-R',
        repo,
        '--json',
        'number,title,labels,state,author,createdAt',
        '--limit',
        '1000',
        '--state',
        'open',
        '--label',
        'shipper:planned',
      ],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
  });

  it('passes --state when state option is provided', async () => {
    queueExecFileResult('[]');

    await listIssues(repo, { state: 'closed' });

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      [
        'issue',
        'list',
        '-R',
        repo,
        '--json',
        'number,title,labels,state,author,createdAt',
        '--limit',
        '1000',
        '--state',
        'closed',
      ],
      { encoding: 'utf-8' },
      expect.any(Function)
    );
  });
});
