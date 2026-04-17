import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GhPayloadError } from '../../../core/src/lib/gh-json.js';
import {
  parseMergeQueueSearch,
  parsePrMergeStateView,
  parsePrViewForMerge,
} from '../../../core/src/lib/gh-schemas.js';
import { toError, toErrorMessage } from '../../../core/src/lib/errors.js';

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
const getLinkedIssueNumberMock = vi.fn<
  (
    prNumber: number,
    nwo: string,
    logger?: {
      log(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    }
  ) => Promise<number | null>
>();
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
    dryRun: boolean,
    logger?: {
      log(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    }
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
  GhPayloadError,
  parseMergeQueueSearch,
  parsePrMergeStateView,
  parsePrViewForMerge,
  toError,
  toErrorMessage,
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
  getLinkedIssueNumber: (
    prNumber: number,
    nwo: string,
    logger?: {
      log(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    }
  ) => getLinkedIssueNumberMock(prNumber, nwo, logger),
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
    dryRun: boolean,
    logger?: {
      log(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    }
  ) => postMergeMock(pr, issueNumber, nwo, dryRun, logger),
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

const { lookupPR, mergeCommand } = await import('../../src/commands/merge.js');

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

    if (args[0] === 'pr' && (args[1] === 'edit' || args[1] === 'comment')) {
      return {
        stdout: '',
        stderr: '',
      };
    }

    throw new Error(`Unexpected gh args: ${args.join(' ')}`);
  });
}

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

  it('propagates shared validation errors for malformed payloads', async () => {
    ghMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Broken PR',
        headRefName: 'feat',
        baseRefName: 'main',
        state: 'OPEN',
        labels: [{}],
      }),
      stderr: '',
    });

    const promise = lookupPR('42', 'owner/repo');
    await expect(promise).rejects.toThrow(GhPayloadError);
    await expect(promise).rejects.toThrow(
      'gh returned an invalid PrViewForMerge payload: expected string at labels[0].name'
    );
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

  it('fails and dequeues PRs when no linked issue can be determined', async () => {
    mockLookupPrView();
    getLinkedIssueNumberMock.mockResolvedValueOnce(null);

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(executeMergeMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      "[shipper]   PR #42 failed: Could not determine linked issue for PR #42. Add a closing reference such as 'Closes #123' to the PR body and re-queue it."
    );
    const commentCall = ghMock.mock.calls.find(
      ([args]) => args[0] === 'pr' && args[1] === 'comment'
    )?.[0];
    const commentBody = commentCall?.at(-1);
    expect(commentBody).toContain('Merge failed for PR #42.');
    expect(commentBody).toContain(
      "Could not determine linked issue for PR #42. Add a closing reference such as 'Closes #123' to the PR body and re-queue it."
    );
    expect(ghMock.mock.calls.map(([args]) => args)).toContainEqual([
      'pr',
      'edit',
      '42',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:ready',
    ]);
    expect(ghMock.mock.calls.map(([args]) => args)).toContainEqual([
      'pr',
      'edit',
      '42',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:pr-reviewed',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('logs explicit queue-level context when the shared helper throws', async () => {
    mockLookupPrView();
    executeMergeMock.mockRejectedValueOnce(new Error('boom'));

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(errorMock).toHaveBeenCalledWith(
      '[shipper]   Merge execution failed for PR #42; the shared merge helper already logged the detailed failure and applied remediation.'
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
      true,
      expect.any(Object)
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
