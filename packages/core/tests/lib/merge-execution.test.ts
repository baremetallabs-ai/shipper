import { beforeEach, describe, expect, it, vi } from 'vitest';

const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();
const fetchChecksMock = vi.fn<(repo: string, prNumber: string) => Promise<unknown[]>>();
const classifyChecksMock = vi.fn<
  (checks: unknown[]) => {
    pending: Array<{ name: string }>;
    failed: Array<{ name: string }>;
    passed: Array<{ name: string }>;
    total: number;
  }
>();
const getSettingsMock = vi.fn<
  () => {
    merge: { requirePassingChecks: boolean };
  }
>();
const sleepMsMock = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
const withStageHooksMock =
  vi.fn<
    (
      stage: string,
      env: { issueNumber?: string; branchName?: string },
      fn: () => Promise<unknown>
    ) => Promise<unknown>
  >();

const logMock = vi.fn<(message: string) => void>();
const warnMock = vi.fn<(message: string) => void>();
const errorMock = vi.fn<(message: string) => void>();

vi.mock('../../src/lib/gh.js', () => ({
  gh: (args: string[]) => ghMock(args),
}));

vi.mock('../../src/lib/checks.js', () => ({
  fetchChecks: (repo: string, prNumber: string) => fetchChecksMock(repo, prNumber),
  classifyChecks: (checks: unknown[]) => classifyChecksMock(checks),
}));

vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => getSettingsMock(),
}));

vi.mock('../../src/lib/sleep.js', () => ({
  sleepMs: (ms: number) => sleepMsMock(ms),
}));

vi.mock('../../src/lib/hooks.js', () => ({
  withStageHooks: (
    stage: string,
    env: { issueNumber?: string; branchName?: string },
    fn: () => Promise<unknown>
  ) => withStageHooksMock(stage, env, fn),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    log: (message: string) => {
      logMock(message);
    },
    warn: (message: string) => {
      warnMock(message);
    },
    error: (message: string) => {
      errorMock(message);
    },
  },
}));

const { executeMerge, getLinkedIssueNumber, pollPrMerged, postMerge } =
  await import('../../src/lib/merge-execution.js');

const pr = {
  number: 456,
  title: 'Ready PR',
  headRefName: 'shipper/123',
  baseRefName: 'main',
  labeledAt: '2026-04-14T00:00:00Z',
};

function defaultGh(args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeStateStatus,mergeable')) {
    return Promise.resolve({
      stdout: JSON.stringify({ mergeStateStatus: 'CLEAN', mergeable: 'UNKNOWN' }),
      stderr: '',
    });
  }

  if (args[0] === 'pr' && args[1] === 'merge') {
    return Promise.resolve({ stdout: 'merged\n', stderr: '' });
  }

  if (args[0] === 'pr' && args[1] === 'update-branch') {
    return Promise.resolve({ stdout: 'rebased\n', stderr: '' });
  }

  if (args[0] === 'issue' && args[1] === 'edit') {
    return Promise.resolve({ stdout: '', stderr: '' });
  }

  if (args[0] === 'issue' && args[1] === 'close') {
    return Promise.resolve({ stdout: '', stderr: '' });
  }

  if (args[0] === 'pr' && args[1] === 'edit') {
    return Promise.resolve({ stdout: '', stderr: '' });
  }

  if (args[0] === 'pr' && args[1] === 'comment') {
    return Promise.resolve({ stdout: '', stderr: '' });
  }

  if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
    return Promise.resolve({ stdout: JSON.stringify({ body: 'Closes #123' }), stderr: '' });
  }

  if (args[0] === 'pr' && args[1] === 'view' && args.includes('state')) {
    return Promise.resolve({ stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' });
  }

  throw new Error(`Unexpected gh args: ${args.join(' ')}`);
}

function setupMergeStateSequence(states: string[], mergeable = 'UNKNOWN'): void {
  let index = 0;
  ghMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeStateStatus,mergeable')) {
      const state = states[Math.min(index, states.length - 1)] ?? 'CLEAN';
      index += 1;
      return {
        stdout: JSON.stringify({ mergeStateStatus: state, mergeable }),
        stderr: '',
      };
    }

    return await defaultGh(args);
  });
}

function expectFailureComment(reason: string): void {
  const commentCall = ghMock.mock.calls.find(
    ([args]) => args[0] === 'pr' && args[1] === 'comment'
  )?.[0];
  expect(commentCall).toBeDefined();
  expect(commentCall).toContain(
    [
      'Merge failed for PR #456.',
      '',
      `**Reason:** ${reason}`,
      '',
      'The `shipper:pr-reviewed` label has been re-applied so the PR can be remediated and re-queued.',
    ].join('\n')
  );
}

beforeEach(() => {
  ghMock.mockReset();
  fetchChecksMock.mockReset();
  classifyChecksMock.mockReset();
  getSettingsMock.mockReset();
  sleepMsMock.mockReset();
  withStageHooksMock.mockReset();
  logMock.mockReset();
  warnMock.mockReset();
  errorMock.mockReset();

  ghMock.mockImplementation(defaultGh);
  fetchChecksMock.mockResolvedValue([]);
  classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });
  getSettingsMock.mockReturnValue({ merge: { requirePassingChecks: true } });
  sleepMsMock.mockResolvedValue(undefined);
  withStageHooksMock.mockImplementation(async (_stage, _env, fn) => await fn());
});

describe('executeMerge', () => {
  it('merges a CLEAN PR and runs post-merge cleanup', async () => {
    setupMergeStateSequence(['CLEAN']);

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).resolves.toBe(true);

    expect(ghMock.mock.calls.map(([args]) => args.slice(0, 2))).toContainEqual(['pr', 'merge']);
    expect(ghMock.mock.calls.map(([args]) => args.slice(0, 2))).toContainEqual(['issue', 'edit']);
    expect(ghMock.mock.calls.map(([args]) => args.slice(0, 2))).toContainEqual(['issue', 'close']);
    expect(withStageHooksMock).toHaveBeenCalledWith(
      'merge',
      { issueNumber: '123', branchName: 'shipper/123' },
      expect.any(Function)
    );
  });

  it('rebases a BEHIND PR, re-evaluates merge state, and merges in one call', async () => {
    setupMergeStateSequence(['BEHIND', 'CLEAN']);

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).resolves.toBe(true);

    expect(ghMock.mock.calls.map(([args]) => args.slice(0, 2))).toContainEqual([
      'pr',
      'update-branch',
    ]);
    expect(ghMock.mock.calls.map(([args]) => args.slice(0, 2))).toContainEqual(['pr', 'merge']);
  });

  it('polls UNKNOWN state until it resolves and then merges', async () => {
    setupMergeStateSequence(['UNKNOWN', 'UNKNOWN', 'CLEAN']);

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).resolves.toBe(true);

    expect(sleepMsMock.mock.calls).toEqual([[3000], [3000]]);
    expect(ghMock.mock.calls.map(([args]) => args.slice(0, 2))).toContainEqual(['pr', 'merge']);
  });

  it('fails after exhausting UNKNOWN polling', async () => {
    setupMergeStateSequence(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).rejects.toThrow(
      'Merge failed for PR #456: GitHub has not computed merge state for PR #456 yet. Retry shortly.'
    );

    expect(sleepMsMock.mock.calls).toHaveLength(5);
    expectFailureComment('GitHub has not computed merge state for PR #456 yet. Retry shortly.');
  });

  it('fails DIRTY PRs', async () => {
    setupMergeStateSequence(['DIRTY']);

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).rejects.toThrow(
      'Merge failed for PR #456: PR #456 has merge conflicts that must be resolved.'
    );
  });

  it('fails BLOCKED PRs when checks are failing', async () => {
    setupMergeStateSequence(['BLOCKED']);
    fetchChecksMock.mockResolvedValue([{ name: 'build' }]);
    classifyChecksMock.mockReturnValue({
      pending: [],
      failed: [{ name: 'build' }],
      passed: [],
      total: 1,
    });

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).rejects.toThrow('Merge failed for PR #456: PR #456 is blocked by failed CI checks: build.');
  });

  it('returns retry-later for BLOCKED PRs with pending checks in queue mode', async () => {
    setupMergeStateSequence(['BLOCKED']);
    fetchChecksMock.mockResolvedValue([{ name: 'lint' }]);
    classifyChecksMock.mockReturnValue({
      pending: [{ name: 'lint' }],
      failed: [],
      passed: [],
      total: 1,
    });

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).resolves.toBe(false);

    expect(ghMock.mock.calls.map(([args]) => args.slice(0, 2))).not.toContainEqual([
      'pr',
      'comment',
    ]);
  });

  it('fails pending checks for ship-side callers when pending checks are treated as failures', async () => {
    setupMergeStateSequence(['BLOCKED']);
    fetchChecksMock.mockResolvedValue([{ name: 'lint' }]);
    classifyChecksMock.mockReturnValue({
      pending: [{ name: 'lint' }],
      failed: [],
      passed: [],
      total: 1,
    });

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: true,
      })
    ).rejects.toThrow(
      'Merge failed for PR #456: PR #456 is blocked by pending CI checks: lint. Retry when they complete.'
    );
  });

  it('enforces requirePassingChecks for otherwise mergeable PRs', async () => {
    setupMergeStateSequence(['CLEAN']);
    fetchChecksMock.mockResolvedValue([{ name: 'test' }]);
    classifyChecksMock.mockReturnValue({
      pending: [],
      failed: [{ name: 'test' }],
      passed: [],
      total: 1,
    });

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).rejects.toThrow('Merge failed for PR #456: PR #456 has failed CI checks: test.');
  });

  it('rolls labels back on both the PR and the linked issue when merge fails', async () => {
    setupMergeStateSequence(['DIRTY']);

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).rejects.toThrow();

    const prEditCall = ghMock.mock.calls.find(
      ([args]) => args[0] === 'pr' && args[1] === 'edit'
    )?.[0];
    const issueEditCall = ghMock.mock.calls.find(
      ([args]) => args[0] === 'issue' && args[1] === 'edit'
    )?.[0];

    expect(prEditCall).toEqual([
      'pr',
      'edit',
      '456',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:ready',
      '--add-label',
      'shipper:pr-reviewed',
    ]);
    expect(issueEditCall).toEqual([
      'issue',
      'edit',
      '123',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:ready',
      '--add-label',
      'shipper:pr-reviewed',
    ]);
    expectFailureComment('PR #456 has merge conflicts that must be resolved.');
  });

  it('salvages merges after a merge RPC error when GitHub eventually reports MERGED', async () => {
    setupMergeStateSequence(['CLEAN']);
    let stateChecks = 0;
    ghMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeStateStatus,mergeable')) {
        return {
          stdout: JSON.stringify({ mergeStateStatus: 'CLEAN', mergeable: 'UNKNOWN' }),
          stderr: '',
        };
      }

      if (args[0] === 'pr' && args[1] === 'merge') {
        throw new Error('merge timed out');
      }

      if (args[0] === 'pr' && args[1] === 'view' && args.includes('state')) {
        const state = stateChecks === 0 ? 'OPEN' : 'MERGED';
        stateChecks += 1;
        return { stdout: JSON.stringify({ state }), stderr: '' };
      }

      return await defaultGh(args);
    });

    await expect(
      executeMerge({
        pr,
        issueNumber: 123,
        nwo: 'owner/repo',
        logger: { log: logMock, warn: warnMock, error: errorMock } as never,
        treatPendingChecksAsFailure: false,
      })
    ).resolves.toBe(true);

    expect(sleepMsMock.mock.calls).toEqual([[1000]]);
    expect(ghMock.mock.calls.map(([args]) => args.slice(0, 2))).toContainEqual(['issue', 'close']);
  });
});

describe('shared helpers', () => {
  it('extracts linked issue numbers from PR bodies', async () => {
    await expect(getLinkedIssueNumber(456, 'owner/repo')).resolves.toBe(123);
  });

  it('uses the caller logger for linked-issue lookup warnings', async () => {
    ghMock.mockRejectedValueOnce(new Error('gh failed'));
    const localWarn = vi.fn<(message: string) => void>();

    await expect(
      getLinkedIssueNumber(456, 'owner/repo', {
        log: vi.fn(),
        warn: localWarn,
        error: vi.fn(),
      } as never)
    ).resolves.toBeNull();

    expect(localWarn).toHaveBeenCalledWith('Failed to fetch linked issue for PR #456');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('polls merged state with exponential backoff', async () => {
    let calls = 0;
    ghMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('state')) {
        const state = calls === 0 ? 'OPEN' : 'MERGED';
        calls += 1;
        return { stdout: JSON.stringify({ state }), stderr: '' };
      }

      return await defaultGh(args);
    });

    await expect(pollPrMerged(456, 'owner/repo')).resolves.toBe(true);
    expect(sleepMsMock.mock.calls).toEqual([[1000]]);
  });

  it('supports dry-run post-merge cleanup', async () => {
    await expect(postMerge(pr, 123, 'owner/repo', true)).resolves.toBeUndefined();
    expect(logMock).toHaveBeenCalledWith(
      '  [dry-run] Would remove shipper:ready and close issue #123'
    );
  });

  it('uses the caller logger for dry-run post-merge cleanup logs', async () => {
    const localLog = vi.fn<(message: string) => void>();

    await expect(
      postMerge(pr, 123, 'owner/repo', true, {
        log: localLog,
        warn: vi.fn(),
        error: vi.fn(),
      } as never)
    ).resolves.toBeUndefined();

    expect(localLog).toHaveBeenCalledWith(
      '  [dry-run] Would remove shipper:ready and close issue #123'
    );
    expect(logMock).not.toHaveBeenCalled();
  });
});
