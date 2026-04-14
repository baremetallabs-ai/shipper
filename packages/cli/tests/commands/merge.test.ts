import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const executeMergeMock = vi.fn<
  (options: {
    pr: {
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
      labeledAt: string;
    };
    issueNumber: number;
    nwo: string;
    treatPendingChecksAsFailure: boolean;
  }) => Promise<boolean>
>();
const getLinkedIssueNumberMock = vi.fn<(prNumber: number, nwo: string) => Promise<number | null>>();
const postMergeMock = vi.fn<
  (
    pr: {
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
      labeledAt: string;
    },
    issueNumber: number,
    nwo: string,
    dryRun: boolean
  ) => Promise<void>
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
  executeMerge: (options: {
    pr: {
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
      labeledAt: string;
    };
    issueNumber: number;
    nwo: string;
    treatPendingChecksAsFailure: boolean;
  }) => executeMergeMock(options),
  getLinkedIssueNumber: (prNumber: number, nwo: string) => getLinkedIssueNumberMock(prNumber, nwo),
  postMerge: (
    pr: {
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
      labeledAt: string;
    },
    issueNumber: number,
    nwo: string,
    dryRun: boolean
  ) => postMergeMock(pr, issueNumber, nwo, dryRun),
  fetchChecks: vi.fn(() => Promise.resolve([])),
  classifyChecks: vi.fn(() => ({ pending: [], failed: [], passed: [], total: 0 })),
  sleepMs: (ms: number) => sleepMsMock(ms),
}));

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  ghMock.mockReset();
  getSettingsMock.mockReset();
  tryResolvePrForIssueMock.mockReset();
  executeMergeMock.mockReset();
  getLinkedIssueNumberMock.mockReset();
  postMergeMock.mockReset();
  sleepMsMock.mockReset();
  sleepMsMock.mockResolvedValue(undefined);
  process.exitCode = undefined;
  logMock.mockClear();
  warnMock.mockClear();
  errorMock.mockClear();
  getSettingsMock.mockReturnValue({
    prReviewWait: { mode: 'checks', maxDurationMinutes: 30 },
    merge: { requirePassingChecks: true },
  });
  executeMergeMock.mockResolvedValue(true);
  getLinkedIssueNumberMock.mockResolvedValue(10);
  postMergeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  process.exitCode = undefined;
});

const { parseGraphQLResponse, parsePRViewData, lookupPR, mergeCommand } =
  await import('../../src/commands/merge.js');

function mockLookupPrView(options?: {
  ref?: string;
  labels?: { name: string }[];
  state?: string;
  number?: number;
  title?: string;
  headRefName?: string;
  baseRefName?: string;
}): void {
  const {
    ref = '42',
    labels = [{ name: 'shipper:ready' }],
    state = 'OPEN',
    number = 42,
    title = 'Test PR',
    headRefName = 'feat',
    baseRefName = 'main',
  } = options ?? {};

  ghMock.mockImplementation((args: string[]) => {
    if (
      args[0] === 'pr' &&
      args[1] === 'view' &&
      args[2] === ref &&
      args.includes('--json') &&
      args.includes('number,title,headRefName,baseRefName,state,labels')
    ) {
      return {
        stdout: JSON.stringify({
          number,
          title,
          headRefName,
          baseRefName,
          state,
          labels,
        }),
        stderr: '',
      };
    }

    throw new Error(`Unexpected gh args: ${args.join(' ')}`);
  });
}

describe('parseGraphQLResponse', () => {
  it('parses a valid GraphQL response', () => {
    const parsed = parseGraphQLResponse(
      JSON.stringify({
        data: {
          search: {
            nodes: [
              {
                number: 42,
                title: 'Test PR',
                headRefName: 'shipper/42',
                baseRefName: 'main',
                timelineItems: {
                  nodes: [{ createdAt: '2026-04-14T00:00:00Z', label: { name: 'shipper:ready' } }],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    );

    expect(parsed.data.search.nodes).toHaveLength(1);
    expect(parsed.data.search.pageInfo.hasNextPage).toBe(false);
  });

  it('throws when search results are missing', () => {
    expect(() => parseGraphQLResponse(JSON.stringify({ data: {} }))).toThrow(
      'GitHub GraphQL response was missing search results.'
    );
  });
});

describe('parsePRViewData', () => {
  it('parses a valid pull request payload', () => {
    expect(parsePRViewData(JSON.stringify({ mergeStateStatus: 'CLEAN' }))).toEqual({
      mergeStateStatus: 'CLEAN',
    });
  });

  it('throws when mergeStateStatus is missing', () => {
    expect(() => parsePRViewData(JSON.stringify({ state: 'OPEN' }))).toThrow(
      'GitHub CLI returned an invalid pull request view payload.'
    );
  });
});

describe('lookupPR', () => {
  it('returns a queued PR for an open ready PR', async () => {
    mockLookupPrView();

    await expect(lookupPR('42', 'owner/repo')).resolves.toEqual({
      number: 42,
      title: 'Test PR',
      headRefName: 'feat',
      baseRefName: 'main',
      labeledAt: '',
    });
  });

  it('rejects PRs without shipper:ready', async () => {
    mockLookupPrView({ labels: [{ name: 'shipper:pr-reviewed' }] });

    await expect(lookupPR('42', 'owner/repo')).rejects.toThrow(
      'Error: PR #42 does not have the shipper:ready label.'
    );
  });

  it('resolves issue references through tryResolvePrForIssue', async () => {
    tryResolvePrForIssueMock.mockResolvedValue('99');
    mockLookupPrView({ ref: '99', number: 99 });
    ghMock.mockImplementationOnce(() => {
      throw new Error('not a PR');
    });

    await expect(lookupPR('42', 'owner/repo')).resolves.toEqual(
      expect.objectContaining({ number: 99 })
    );
    expect(tryResolvePrForIssueMock).toHaveBeenCalledWith('owner/repo', 42);
  });
});

describe('mergeCommand', () => {
  it('rejects non-numeric PR or issue numbers', async () => {
    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: 'abc' })
    ).rejects.toThrow('Error: argument must be a numeric issue or PR number.');
  });

  it('rejects non-numeric polling intervals', async () => {
    await expect(mergeCommand({ interval: 'abc', once: false, dryRun: false })).rejects.toThrow(
      'Error: --interval must be a positive integer (seconds).'
    );
  });

  it('rejects polling intervals smaller than one second', async () => {
    await expect(mergeCommand({ interval: '0', once: false, dryRun: false })).rejects.toThrow(
      'Error: --interval must be a positive integer (seconds).'
    );
  });

  it('delegates real single-shot execution to the shared helper', async () => {
    mockLookupPrView();

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    const call = executeMergeMock.mock.calls[0]?.[0];
    expect(call).toEqual({
      pr: {
        number: 42,
        title: 'Test PR',
        headRefName: 'feat',
        baseRefName: 'main',
        labeledAt: '',
      },
      issueNumber: 10,
      nwo: 'owner/repo',
      logger: expect.any(Object) as Record<string, unknown>,
      treatPendingChecksAsFailure: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exitCode when the shared helper asks to retry later', async () => {
    mockLookupPrView();
    executeMergeMock.mockResolvedValueOnce(false);

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(process.exitCode).toBe(1);
  });

  it('skips helper execution when no linked issue can be determined', async () => {
    mockLookupPrView();
    getLinkedIssueNumberMock.mockResolvedValueOnce(null);

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(executeMergeMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Could not determine linked issue for PR #42. Skipping post-merge actions.'
    );
    expect(process.exitCode).toBe(1);
  });

  it('keeps the dry-run BEHIND branch in merge.ts and does not call the helper', async () => {
    mockLookupPrView({ title: 'Behind PR' });
    ghMock.mockImplementation((args: string[]) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args.includes('number,title,headRefName,baseRefName,state,labels')
      ) {
        return {
          stdout: JSON.stringify({
            number: 42,
            title: 'Behind PR',
            headRefName: 'feat',
            baseRefName: 'main',
            state: 'OPEN',
            labels: [{ name: 'shipper:ready' }],
          }),
          stderr: '',
        };
      }

      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json')) {
        return { stdout: JSON.stringify({ mergeStateStatus: 'BEHIND' }), stderr: '' };
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });

    await mergeCommand({ interval: '30', once: true, dryRun: true, number: '42' });

    expect(executeMergeMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      '[shipper]   [dry-run] Would run: gh pr update-branch --rebase'
    );
    expect(process.exitCode).toBe(1);
  });

  it('keeps the dry-run merge path in merge.ts and uses postMerge with dryRun=true', async () => {
    mockLookupPrView({ title: 'Ready PR' });
    ghMock.mockImplementation((args: string[]) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args.includes('number,title,headRefName,baseRefName,state,labels')
      ) {
        return {
          stdout: JSON.stringify({
            number: 42,
            title: 'Ready PR',
            headRefName: 'feat',
            baseRefName: 'main',
            state: 'OPEN',
            labels: [{ name: 'shipper:ready' }],
          }),
          stderr: '',
        };
      }

      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json')) {
        return { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }), stderr: '' };
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });

    await mergeCommand({ interval: '30', once: true, dryRun: true, number: '42' });

    expect(executeMergeMock).not.toHaveBeenCalled();
    expect(postMergeMock).toHaveBeenCalledWith(
      {
        number: 42,
        title: 'Ready PR',
        headRefName: 'feat',
        baseRefName: 'main',
        labeledAt: '',
      },
      10,
      'owner/repo',
      true
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('sorts queue-mode candidates FIFO and delegates the first PR only', async () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        return {
          stdout: JSON.stringify({
            data: {
              search: {
                nodes: [
                  {
                    number: 2,
                    title: 'Second',
                    headRefName: 'shipper/2',
                    baseRefName: 'main',
                    timelineItems: {
                      nodes: [
                        { createdAt: '2026-04-14T00:00:02Z', label: { name: 'shipper:ready' } },
                      ],
                    },
                  },
                  {
                    number: 1,
                    title: 'First',
                    headRefName: 'shipper/1',
                    baseRefName: 'main',
                    timelineItems: {
                      nodes: [
                        { createdAt: '2026-04-14T00:00:01Z', label: { name: 'shipper:ready' } },
                      ],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          stderr: '',
        };
      }

      throw new Error(`Unexpected gh args: ${args.join(' ')}`);
    });
    getLinkedIssueNumberMock.mockResolvedValueOnce(77);

    await mergeCommand({ interval: '30', once: true, dryRun: false });

    expect(executeMergeMock).toHaveBeenCalledTimes(1);
    const call = executeMergeMock.mock.calls[0]?.[0];
    expect(call?.pr).toEqual(
      expect.objectContaining({ number: 1, labeledAt: '2026-04-14T00:00:01Z' })
    );
    expect(call?.issueNumber).toBe(77);
  });
});
