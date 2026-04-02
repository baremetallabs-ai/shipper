import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toError, toErrorMessage } from '../../../core/src/lib/errors.js';
import { isPlainObject } from '../../../core/src/lib/type-guards.js';

const tryResolvePrForIssueMock =
  vi.fn<(repo: string, issueNumber: number) => Promise<string | undefined>>();
const getSettingsMock = vi.fn<
  () => {
    prReviewWait: { mode: 'checks'; minDurationMinutes?: number; maxDurationMinutes?: number };
    merge: { requirePassingChecks: boolean };
  }
>();
const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();
interface MockCheck {
  name: string;
  state: string;
  bucket: string;
}

const fetchChecksMock = vi.fn<(repo: string, pr: string) => Promise<MockCheck[]>>();
const classifyChecksMock = vi.fn<
  (checks: MockCheck[]) => {
    pending: MockCheck[];
    failed: MockCheck[];
    passed: MockCheck[];
    total: number;
  }
>();
const sleepMsMock = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

vi.mock('@dnsquared/shipper-core', () => ({
  logger: {
    log: (message: string) => {
      console.log(`[shipper] ${message}`);
    },
    warn: (message: string) => {
      console.warn(`[shipper] ${message}`);
    },
    error: (message: string) => {
      console.error(`[shipper] ${message}`);
    },
  },
  toError,
  toErrorMessage,
  isPlainObject,
  getSettings: () => getSettingsMock(),
  gh: (args: string[]) => ghMock(args),
  tryResolvePrForIssue: (repo: string, issueNumber: number) =>
    tryResolvePrForIssueMock(repo, issueNumber),
  getRepoNwo: () => 'owner/repo',
  withStageHooks: vi.fn((_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => fn()),
  fetchChecks: (repo: string, pr: string) => fetchChecksMock(repo, pr),
  classifyChecks: (checks: MockCheck[]) => classifyChecksMock(checks),
  sleepMs: (ms: number) => sleepMsMock(ms),
}));

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  ghMock.mockReset();
  getSettingsMock.mockReset();
  tryResolvePrForIssueMock.mockReset();
  fetchChecksMock.mockReset();
  classifyChecksMock.mockReset();
  sleepMsMock.mockReset();
  sleepMsMock.mockResolvedValue(undefined);
  logMock.mockClear();
  warnMock.mockClear();
  errorMock.mockClear();
  getSettingsMock.mockReturnValue({
    prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
    merge: { requirePassingChecks: true },
  });
});

const {
  getLinkedIssueNumber,
  isPrMerged,
  parseGraphQLResponse,
  parsePRViewData,
  parsePRStateViewData,
  postMerge,
  lookupPR,
  mergeCommand,
  pollPrMerged,
} = await import('../../src/commands/merge.js');

describe('isPrMerged', () => {
  it('returns null and warns when gh pr view throws', async () => {
    ghMock.mockRejectedValue(new Error('gh failed'));

    await expect(isPrMerged(42, 'owner/repo')).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith('[shipper] Failed to check merge status for PR #42');
  });
});

interface MockPRLookupOptions {
  linkedIssueBody?: string;
  linkedIssueError?: Error;
  mergeError?: Error;
  mergeStateError?: Error;
  mergeStateStdout?: string;
  mergeStdout?: string;
  updateBranchError?: Error;
  updateBranchStdout?: string;
  verificationState?: string;
  verificationStates?: string[];
  verificationError?: Error;
  verificationStdout?: string;
  failPRErrors?: {
    removeLabel?: Error;
    addLabel?: Error;
    comment?: Error;
  };
}

function mockPRLookup(mergeStateStatus: string, options?: MockPRLookupOptions) {
  const {
    linkedIssueBody = 'Closes #10',
    linkedIssueError,
    mergeError,
    mergeStateError,
    mergeStateStdout,
    mergeStdout,
    updateBranchError,
    updateBranchStdout,
    verificationState = 'OPEN',
    verificationStates,
    verificationError,
    verificationStdout,
    failPRErrors,
  } = options ?? {};
  let verificationAttempt = 0;

  ghMock.mockImplementation((args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      const jsonIndex = args.indexOf('--json');
      const jsonFields = jsonIndex >= 0 ? (args[jsonIndex + 1] ?? '') : '';
      if (jsonFields === 'mergeStateStatus') {
        if (mergeStateError) {
          return Promise.reject(mergeStateError);
        }

        return Promise.resolve({
          stdout: mergeStateStdout ?? JSON.stringify({ mergeStateStatus }),
          stderr: '',
        });
      }
      if (jsonFields === 'state') {
        if (verificationError) {
          return Promise.reject(verificationError);
        }
        const state =
          verificationStates?.[Math.min(verificationAttempt, verificationStates.length - 1)] ??
          verificationState;
        verificationAttempt += 1;
        return Promise.resolve({
          stdout: verificationStdout ?? JSON.stringify({ state }),
          stderr: '',
        });
      }
      if (jsonFields === 'number,title,headRefName,baseRefName,state,labels') {
        return Promise.resolve({
          stdout: JSON.stringify({
            number: 42,
            title: 'Test PR',
            headRefName: 'feat',
            baseRefName: 'main',
            state: 'OPEN',
            labels: [{ name: 'shipper:ready' }],
          }),
          stderr: '',
        });
      }
      if (jsonFields.includes('body')) {
        if (linkedIssueError) {
          return Promise.reject(linkedIssueError);
        }

        return Promise.resolve({
          stdout: JSON.stringify({ body: linkedIssueBody }),
          stderr: '',
        });
      }
    }

    if (args[0] === 'pr' && args[1] === 'update-branch') {
      if (updateBranchError) {
        return Promise.reject(updateBranchError);
      }

      return Promise.resolve({ stdout: updateBranchStdout ?? '', stderr: '' });
    }

    if (args[0] === 'pr' && args[1] === 'merge') {
      if (mergeError) {
        return Promise.reject(mergeError);
      }
      return Promise.resolve({ stdout: mergeStdout ?? '', stderr: '' });
    }

    if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label')) {
      if (failPRErrors?.removeLabel) {
        return Promise.reject(failPRErrors.removeLabel);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label')) {
      if (failPRErrors?.addLabel) {
        return Promise.reject(failPRErrors.addLabel);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    if (args[0] === 'pr' && args[1] === 'comment') {
      if (failPRErrors?.comment) {
        return Promise.reject(failPRErrors.comment);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    if (args[0] === 'issue') {
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    return Promise.resolve({ stdout: '', stderr: '' });
  });
}

describe('pollPrMerged', () => {
  it('returns true after exponential backoff when a later check observes MERGED', async () => {
    const verificationStates = ['OPEN', 'OPEN', 'MERGED'];
    let verificationAttempt = 0;
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && args[args.indexOf('--json') + 1] === 'state') {
        const state =
          verificationStates[Math.min(verificationAttempt, verificationStates.length - 1)];
        verificationAttempt += 1;
        return Promise.resolve({ stdout: JSON.stringify({ state }), stderr: '' });
      }

      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(pollPrMerged(42, 'owner/repo')).resolves.toBe(true);
    expect(findPrStateViewCalls()).toHaveLength(3);
    expect(sleepMsMock.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it('returns false after exhausting all polling attempts', async () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && args[args.indexOf('--json') + 1] === 'state') {
        return Promise.resolve({ stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' });
      }

      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(pollPrMerged(42, 'owner/repo')).resolves.toBe(false);
    expect(findPrStateViewCalls()).toHaveLength(5);
    expect(sleepMsMock.mock.calls).toEqual([[1_000], [2_000], [4_000], [8_000]]);
  });
});

const mockPR = {
  number: 42,
  title: 'Test PR',
  headRefName: '25-add-feature',
  baseRefName: 'main',
  labeledAt: '2026-01-01T00:00:00Z',
};

describe('parseGraphQLResponse', () => {
  const validResponse = {
    data: {
      search: {
        nodes: [
          {
            number: 42,
            title: 'Test PR',
            headRefName: 'feat/test',
            baseRefName: 'main',
            timelineItems: {
              nodes: [
                {
                  createdAt: '2026-01-01T00:00:00Z',
                  label: { name: 'shipper:ready' },
                },
              ],
            },
          },
        ],
        pageInfo: {
          hasNextPage: false,
          endCursor: 'cursor-1',
        },
      },
    },
  };

  it('parses a valid GraphQL response', () => {
    expect(parseGraphQLResponse(JSON.stringify(validResponse))).toEqual(validResponse);
  });

  it('throws when data is missing', () => {
    expect(() => parseGraphQLResponse(JSON.stringify({}))).toThrow(
      'GitHub GraphQL response was missing data.'
    );
  });

  it('throws when the top-level response is not an object', () => {
    expect(() => parseGraphQLResponse(JSON.stringify('not-an-object'))).toThrow(
      'GitHub GraphQL response was not an object.'
    );
  });

  it('throws when search results are missing', () => {
    expect(() => parseGraphQLResponse(JSON.stringify({ data: {} }))).toThrow(
      'GitHub GraphQL response was missing search results.'
    );
  });

  it('throws when a search node is invalid', () => {
    expect(() =>
      parseGraphQLResponse(
        JSON.stringify({
          data: {
            search: {
              nodes: ['not-a-node'],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      )
    ).toThrow('GitHub GraphQL response contained an invalid node.');
  });

  it('throws when a pull request node is invalid', () => {
    expect(() =>
      parseGraphQLResponse(
        JSON.stringify({
          data: {
            search: {
              nodes: [
                {
                  number: 42,
                  title: 'Test PR',
                  headRefName: 'feat/test',
                  timelineItems: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      )
    ).toThrow('GitHub GraphQL response contained an invalid pull request node.');
  });

  it('throws when a timeline node is invalid', () => {
    expect(() =>
      parseGraphQLResponse(
        JSON.stringify({
          data: {
            search: {
              nodes: [
                {
                  number: 42,
                  title: 'Test PR',
                  headRefName: 'feat/test',
                  baseRefName: 'main',
                  timelineItems: {
                    nodes: [{ label: { name: 'shipper:ready' } }],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      )
    ).toThrow('GitHub GraphQL response contained an invalid timeline node.');
  });

  it('throws when pageInfo is invalid', () => {
    expect(() =>
      parseGraphQLResponse(
        JSON.stringify({
          data: {
            search: {
              nodes: [],
              pageInfo: { hasNextPage: 'nope', endCursor: null },
            },
          },
        })
      )
    ).toThrow('GitHub GraphQL response contained an invalid pageInfo object.');
  });
});

describe('parsePRViewData', () => {
  it('parses a valid pull request payload', () => {
    expect(parsePRViewData(JSON.stringify({ mergeStateStatus: 'CLEAN' }))).toEqual({
      mergeStateStatus: 'CLEAN',
    });
  });

  it('throws when the payload is not an object', () => {
    expect(() => parsePRViewData(JSON.stringify('not-an-object'))).toThrow(
      'GitHub CLI returned an invalid pull request view payload.'
    );
  });

  it('throws when mergeStateStatus is missing', () => {
    expect(() => parsePRViewData(JSON.stringify({ state: 'OPEN' }))).toThrow(
      'GitHub CLI returned an invalid pull request view payload.'
    );
  });
});

describe('parsePRStateViewData', () => {
  it('parses a valid pull request state payload', () => {
    expect(parsePRStateViewData(JSON.stringify({ state: 'MERGED' }))).toEqual({
      state: 'MERGED',
    });
  });

  it('throws when the payload is not an object', () => {
    expect(() => parsePRStateViewData(JSON.stringify(null))).toThrow(
      'GitHub CLI returned an invalid pull request state payload.'
    );
  });

  it('throws when state is missing', () => {
    expect(() => parsePRStateViewData(JSON.stringify({ mergeStateStatus: 'CLEAN' }))).toThrow(
      'GitHub CLI returned an invalid pull request state payload.'
    );
  });
});

describe('getLinkedIssueNumber', () => {
  it('returns issue number when PR body contains Closes #N', async () => {
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({ body: 'Some text\n\nCloses #25\n' }),
      stderr: '',
    });
    await expect(getLinkedIssueNumber(42, 'owner/repo')).resolves.toBe(25);
    expect(ghMock).toHaveBeenCalledWith(['pr', 'view', '42', '-R', 'owner/repo', '--json', 'body']);
  });

  it('returns issue number for Fixes #N', async () => {
    ghMock.mockResolvedValue({ stdout: JSON.stringify({ body: 'Fixes #10' }), stderr: '' });
    await expect(getLinkedIssueNumber(1, 'o/r')).resolves.toBe(10);
  });

  it('returns issue number for Resolves #N', async () => {
    ghMock.mockResolvedValue({ stdout: JSON.stringify({ body: 'Resolves #99' }), stderr: '' });
    await expect(getLinkedIssueNumber(1, 'o/r')).resolves.toBe(99);
  });

  it('returns null when PR body has no closing keyword', async () => {
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({ body: 'Just a regular PR body' }),
      stderr: '',
    });
    await expect(getLinkedIssueNumber(42, 'owner/repo')).resolves.toBeNull();
  });

  it('returns null when gh pr view throws', async () => {
    ghMock.mockRejectedValue(new Error('gh failed'));
    await expect(getLinkedIssueNumber(42, 'owner/repo')).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith('[shipper] Failed to fetch linked issue for PR #42');
  });
});

describe('postMerge', () => {
  it('cleans up labels and closes issue', async () => {
    ghMock.mockResolvedValue({ stdout: '', stderr: '' });

    await postMerge(mockPR, 25, 'owner/repo', false);

    expect(ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '25',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:ready',
    ]);
    expect(ghMock).toHaveBeenCalledWith(['issue', 'close', '25', '-R', 'owner/repo']);
  });

  it('logs dry-run message', async () => {
    await postMerge(mockPR, 25, 'owner/repo', true);

    expect(ghMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   [dry-run] Would remove shipper:ready and close issue #25'
    );
  });

  it('warns when label removal fails and still closes the issue', async () => {
    ghMock
      .mockRejectedValueOnce(new Error('label removal failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(postMerge(mockPR, 25, 'owner/repo', false)).resolves.toBeUndefined();

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Failed to remove shipper:ready label from issue #25: label removal failed'
    );
    expect(ghMock).toHaveBeenCalledWith(['issue', 'close', '25', '-R', 'owner/repo']);
  });

  it('warns when issue close fails without throwing', async () => {
    ghMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('close failed'));

    await expect(postMerge(mockPR, 25, 'owner/repo', false)).resolves.toBeUndefined();

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Failed to close issue #25: close failed'
    );
  });

  it('warns for both cleanup failures and still resolves', async () => {
    ghMock
      .mockRejectedValueOnce(new Error('label removal failed'))
      .mockRejectedValueOnce(new Error('close failed'));

    await expect(postMerge(mockPR, 25, 'owner/repo', false)).resolves.toBeUndefined();

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Failed to remove shipper:ready label from issue #25: label removal failed'
    );
    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Failed to close issue #25: close failed'
    );
  });
});

describe('lookupPR', () => {
  const validPRJson = JSON.stringify({
    number: 42,
    title: 'Add feature',
    headRefName: 'feature-branch',
    baseRefName: 'main',
    state: 'OPEN',
    labels: [{ name: 'shipper:ready' }],
  });

  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('returns QueuedPR for a valid PR with shipper:ready label', async () => {
    ghMock.mockResolvedValue({ stdout: validPRJson, stderr: '' });

    const result = await lookupPR('42', 'owner/repo');

    expect(result).toEqual({
      number: 42,
      title: 'Add feature',
      headRefName: 'feature-branch',
      baseRefName: 'main',
      labeledAt: '',
    });
    expect(ghMock).toHaveBeenCalledWith([
      'pr',
      'view',
      '42',
      '-R',
      'owner/repo',
      '--json',
      'number,title,headRefName,baseRefName,state,labels',
    ]);
  });

  it('exits with error when PR does not have shipper:ready label', async () => {
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        title: 'Add feature',
        headRefName: 'feature-branch',
        baseRefName: 'main',
        state: 'OPEN',
        labels: [{ name: 'bug' }],
      }),
      stderr: '',
    });

    await expect(lookupPR('42', 'owner/repo')).rejects.toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Error: PR #42 does not have the shipper:ready label.'
    );
  });

  it('exits with error when PR is closed', async () => {
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        title: 'Add feature',
        headRefName: 'feature-branch',
        baseRefName: 'main',
        state: 'CLOSED',
        labels: [{ name: 'shipper:ready' }],
      }),
      stderr: '',
    });

    await expect(lookupPR('42', 'owner/repo')).rejects.toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith('[shipper] Error: PR #42 is not open (state: CLOSED).');
  });

  it('resolves issue to linked PR when ref is not a PR', async () => {
    ghMock
      .mockRejectedValueOnce(new Error('not a PR'))
      .mockResolvedValueOnce({ stdout: validPRJson, stderr: '' });
    tryResolvePrForIssueMock.mockResolvedValue('42');

    const result = await lookupPR('10', 'owner/repo');

    expect(tryResolvePrForIssueMock).toHaveBeenCalledWith('owner/repo', 10);
    expect(result).toEqual({
      number: 42,
      title: 'Add feature',
      headRefName: 'feature-branch',
      baseRefName: 'main',
      labeledAt: '',
    });
  });

  it('exits with error when issue has no linked PR', async () => {
    ghMock.mockRejectedValue(new Error('not found'));
    tryResolvePrForIssueMock.mockResolvedValue(undefined);

    await expect(lookupPR('99', 'owner/repo')).rejects.toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Error: #99 is not a PR and no linked PR was found.'
    );
  });

  it('exits with error when the resolved PR cannot be fetched', async () => {
    ghMock
      .mockRejectedValueOnce(new Error('not a PR'))
      .mockRejectedValueOnce(new Error('resolved PR missing'));
    tryResolvePrForIssueMock.mockResolvedValue('42');

    await expect(lookupPR('10', 'owner/repo')).rejects.toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith('[shipper] Error: Failed to fetch resolved PR #42.');
  });
});

describe('requirePassingChecks', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('merges when all checks pass and requirePassingChecks is true', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }]);
    classifyChecksMock.mockReturnValue({
      pending: [],
      failed: [],
      passed: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }],
      total: 1,
    });

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(ghMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'pr',
        'merge',
        '42',
        '-R',
        'owner/repo',
        '--rebase',
        '--delete-branch',
      ])
    );
  });

  it('fails PR when checks are failing and requirePassingChecks is true', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'FAILURE', bucket: 'fail' }]);
    classifyChecksMock.mockReturnValue({
      pending: [],
      failed: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }],
      passed: [],
      total: 1,
    });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('CI checks failed: ci'));
  });

  it('retries when checks are pending and requirePassingChecks is true', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'PENDING', bucket: 'pending' }]);
    classifyChecksMock.mockReturnValue({
      pending: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
      failed: [],
      passed: [],
      total: 1,
    });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining('Checks still running: ci. Will retry next cycle.')
    );
  });

  it('merges when no checks exist and requirePassingChecks is true', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockResolvedValue([]);
    classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(ghMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'pr',
        'merge',
        '42',
        '-R',
        'owner/repo',
        '--rebase',
        '--delete-branch',
      ])
    );
  });

  it('skips check verification when requirePassingChecks is false', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
      merge: { requirePassingChecks: false },
    });
    mockPRLookup('CLEAN');

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(fetchChecksMock).not.toHaveBeenCalled();
    expect(ghMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'pr',
        'merge',
        '42',
        '-R',
        'owner/repo',
        '--rebase',
        '--delete-branch',
      ])
    );
  });

  it('runs post-merge cleanup when merge reports an error but verification confirms MERGED', async () => {
    mockPRLookup('CLEAN', {
      mergeError: new Error('merge request timed out'),
      verificationStates: ['MERGED'],
    });
    fetchChecksMock.mockResolvedValue([]);
    classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(findPrStateViewCalls()).toHaveLength(1);
    expect(sleepMsMock).not.toHaveBeenCalled();
    expect(ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '10',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:ready',
    ]);
    expect(ghMock).toHaveBeenCalledWith(['issue', 'close', '10', '-R', 'owner/repo']);
    expect(findCalls('pr', 'edit')).toHaveLength(0);
    expect(findCalls('pr', 'comment')).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   PR #42 merge succeeded despite reported error. Proceeding with post-merge cleanup.'
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('remediates when merge reports an error and verification confirms the PR is still open', async () => {
    mockPRLookup('CLEAN', {
      mergeError: new Error('merge failed'),
      verificationStates: ['OPEN'],
    });
    fetchChecksMock.mockResolvedValue([]);
    classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(findPrStateViewCalls()).toHaveLength(5);
    expect(sleepMsMock.mock.calls).toEqual([[1_000], [2_000], [4_000], [8_000]]);
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
    expect(findCalls('issue', 'edit')).toHaveLength(0);
    expect(findCalls('issue', 'close')).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith('[shipper]   PR #42 failed: Merge failed: merge failed');
  });

  it('remediates when merge verification fails after a reported merge error', async () => {
    mockPRLookup('CLEAN', {
      mergeError: new Error('merge failed'),
      verificationStdout: '{"status":"MERGED"}',
    });
    fetchChecksMock.mockResolvedValue([]);
    classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(findPrStateViewCalls()).toHaveLength(5);
    expect(sleepMsMock.mock.calls).toEqual([[1_000], [2_000], [4_000], [8_000]]);
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
    expect(findCalls('issue', 'edit')).toHaveLength(0);
    expect(findCalls('issue', 'close')).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith('[shipper]   PR #42 failed: Merge failed: merge failed');
  });
});

describe('processPR state transitions', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  it('updates a behind branch and retries on the next cycle', async () => {
    mockPRLookup('BEHIND', { updateBranchStdout: 'updated branch\n' });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(ghMock).toHaveBeenCalledWith([
      'pr',
      'update-branch',
      '42',
      '-R',
      'owner/repo',
      '--rebase',
    ]);
    expect(stdoutWriteSpy).toHaveBeenCalledWith('updated branch\n');
    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   Branch updated. Will check again next cycle.'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(0);
    expect(findCalls('pr', 'comment')).toHaveLength(0);
  });

  it('remediates when updating a behind branch fails', async () => {
    mockPRLookup('BEHIND', { updateBranchError: new Error('update failed') });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   PR #42 failed: Failed to update branch: update failed'
    );
  });

  it('remediates when a PR is dirty', async () => {
    mockPRLookup('DIRTY');

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   PR #42 failed: PR has merge conflicts that must be resolved manually.'
    );
  });

  it('logs the dry-run branch update path for behind PRs', async () => {
    mockPRLookup('BEHIND');

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: true, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   [dry-run] Would run: gh pr update-branch --rebase'
    );
    expect(ghMock).not.toHaveBeenCalledWith([
      'pr',
      'update-branch',
      '42',
      '-R',
      'owner/repo',
      '--rebase',
    ]);
  });

  it('remediates blocked PRs with failed checks', async () => {
    mockPRLookup('BLOCKED');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'FAILURE', bucket: 'fail' }]);
    classifyChecksMock.mockReturnValue({
      pending: [],
      failed: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }],
      passed: [],
      total: 1,
    });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith('[shipper]   PR #42 failed: CI checks failed: ci');
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
  });

  it('retries blocked PRs with pending checks', async () => {
    mockPRLookup('BLOCKED');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'PENDING', bucket: 'pending' }]);
    classifyChecksMock.mockReturnValue({
      pending: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
      failed: [],
      passed: [],
      total: 1,
    });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   Checks still running: ci. Will retry next cycle.'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(0);
    expect(findCalls('pr', 'comment')).toHaveLength(0);
  });

  it('retries blocked PRs that are likely awaiting review', async () => {
    mockPRLookup('BLOCKED');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }]);
    classifyChecksMock.mockReturnValue({
      pending: [],
      failed: [],
      passed: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }],
      total: 1,
    });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   PR is blocked (possibly awaiting review approval). Will retry next cycle.'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(0);
    expect(findCalls('pr', 'comment')).toHaveLength(0);
  });

  it('retries when the merge state is unknown', async () => {
    mockPRLookup('UNKNOWN');

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   Merge state not yet computed by GitHub. Will retry next cycle.'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(0);
    expect(findCalls('pr', 'comment')).toHaveLength(0);
  });

  it('retries when the merge state is unexpected', async () => {
    mockPRLookup('BANANA');

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   Unexpected merge state: BANANA. Will retry next cycle.'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(0);
    expect(findCalls('pr', 'comment')).toHaveLength(0);
  });

  it.each(['HAS_HOOKS', 'UNSTABLE'])('merges PRs in the %s state', async (mergeStateStatus) => {
    mockPRLookup(mergeStateStatus);
    fetchChecksMock.mockResolvedValue([]);

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(ghMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'pr',
        'merge',
        '42',
        '-R',
        'owner/repo',
        '--rebase',
        '--delete-branch',
      ])
    );
  });

  it('writes merge stdout before post-merge cleanup', async () => {
    mockPRLookup('CLEAN', { mergeStdout: 'merged output\n' });
    fetchChecksMock.mockResolvedValue([]);

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(stdoutWriteSpy).toHaveBeenCalledWith('merged output\n');
  });

  it('handles dry-run merge cleanup when no linked issue can be determined', async () => {
    mockPRLookup('CLEAN', { linkedIssueBody: 'No linked issue here' });
    fetchChecksMock.mockResolvedValue([]);

    await mergeCommand({ interval: '30', once: true, dryRun: true, number: '42' });

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   [dry-run] Would merge PR #42 with --rebase --delete-branch'
    );
    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Could not determine linked issue for PR #42. Skipping post-merge actions.'
    );
    expect(findCalls('pr', 'merge')).toHaveLength(0);
  });
});

describe('processPR error paths', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('remediates when merge state lookup fails', async () => {
    mockPRLookup('CLEAN', { mergeStateError: new Error('gh exploded') });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   PR #42 failed: Could not determine merge state: gh exploded'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
  });

  it('remediates when merge state lookup returns malformed data', async () => {
    mockPRLookup('CLEAN', { mergeStateStdout: JSON.stringify({ state: 'OPEN' }) });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   PR #42 failed: Could not determine merge state: GitHub CLI returned an invalid pull request view payload.'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
  });

  it('remediates when fetching blocked-state checks fails', async () => {
    mockPRLookup('BLOCKED');
    fetchChecksMock.mockRejectedValue(new Error('checks down'));

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   PR #42 failed: Could not fetch CI checks: checks down'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
  });

  it('remediates when fetching required checks fails for a mergeable PR', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockRejectedValue(new Error('checks down'));

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   PR #42 failed: Could not fetch CI checks: checks down'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
  });
});

describe('failPR remediation', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('removes and reapplies labels before commenting on the PR', async () => {
    mockPRLookup('DIRTY');

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(findCalls('pr', 'edit')).toEqual([
      ['pr', 'edit', '42', '-R', 'owner/repo', '--remove-label', 'shipper:ready'],
      ['pr', 'edit', '42', '-R', 'owner/repo', '--add-label', 'shipper:pr-reviewed'],
    ]);
    expect(findCalls('pr', 'comment')).toEqual([
      [
        'pr',
        'comment',
        '42',
        '-R',
        'owner/repo',
        '--body',
        expect.stringContaining(
          '**Reason:** PR has merge conflicts that must be resolved manually.'
        ),
      ],
    ]);
  });

  it('logs the dry-run remediation path without mutating the PR', async () => {
    mockPRLookup('DIRTY');

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: true, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   [dry-run] Would remove shipper:ready, add shipper:pr-reviewed, comment on PR'
    );
    expect(findCalls('pr', 'edit')).toHaveLength(0);
    expect(findCalls('pr', 'comment')).toHaveLength(0);
  });

  it('logs an error when remove-label fails and continues remediation', async () => {
    mockPRLookup('DIRTY', { failPRErrors: { removeLabel: new Error('remove failed') } });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(errorMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Failed to remove shipper:ready label from PR #42'
    );
    expect(findCalls('pr', 'edit')).toEqual([
      ['pr', 'edit', '42', '-R', 'owner/repo', '--remove-label', 'shipper:ready'],
      ['pr', 'edit', '42', '-R', 'owner/repo', '--add-label', 'shipper:pr-reviewed'],
    ]);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
  });

  it('logs an error when add-label fails and still comments on the PR', async () => {
    mockPRLookup('DIRTY', { failPRErrors: { addLabel: new Error('add failed') } });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(errorMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Failed to add shipper:pr-reviewed label to PR #42'
    );
    expect(findCalls('pr', 'edit')).toEqual([
      ['pr', 'edit', '42', '-R', 'owner/repo', '--remove-label', 'shipper:ready'],
      ['pr', 'edit', '42', '-R', 'owner/repo', '--add-label', 'shipper:pr-reviewed'],
    ]);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
  });

  it('logs an error when commenting fails without changing the exit path', async () => {
    mockPRLookup('DIRTY', { failPRErrors: { comment: new Error('comment failed') } });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(errorMock).toHaveBeenCalledWith('[shipper]   Warning: Failed to comment on PR #42');
    expect(findCalls('pr', 'edit')).toEqual([
      ['pr', 'edit', '42', '-R', 'owner/repo', '--remove-label', 'shipper:ready'],
      ['pr', 'edit', '42', '-R', 'owner/repo', '--add-label', 'shipper:pr-reviewed'],
    ]);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
  });
});

describe('mergeCommand validation', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('rejects non-numeric PR or issue numbers', async () => {
    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: 'abc' })
    ).rejects.toThrow('exit:1');

    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Error: argument must be a numeric issue or PR number.'
    );
  });

  it('rejects non-numeric polling intervals', async () => {
    await expect(mergeCommand({ interval: 'abc', once: true, dryRun: false })).rejects.toThrow(
      'exit:1'
    );

    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Error: --interval must be a positive integer (seconds).'
    );
  });

  it('rejects polling intervals smaller than one second', async () => {
    await expect(mergeCommand({ interval: '0', once: true, dryRun: false })).rejects.toThrow(
      'exit:1'
    );

    expect(errorMock).toHaveBeenCalledWith(
      '[shipper] Error: --interval must be a positive integer (seconds).'
    );
  });
});

function findCalls(command: string, subcommand: string): string[][] {
  return ghMock.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === command && args[1] === subcommand);
}

function findPrStateViewCalls(): string[][] {
  return ghMock.mock.calls
    .map(([args]) => args)
    .filter(
      (args) =>
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args.includes('--json') &&
        args[args.indexOf('--json') + 1] === 'state'
    );
}
