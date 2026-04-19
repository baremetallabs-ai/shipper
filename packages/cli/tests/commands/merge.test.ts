import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PRChecksLine } from '@dnsquared/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';
import { lookupPR, mergeCommand } from '../../src/commands/merge.js';

type FakeCore = ReturnType<typeof createFakeCore>;

const repo = 'owner/repo';

const PASS_CHECKS: PRChecksLine[] = [
  {
    name: 'build',
    state: 'COMPLETED',
    bucket: 'pass',
    link: 'https://github.com/owner/repo/actions/runs/789',
  },
];

function prSummaryPayload(options: {
  number: number;
  title?: string;
  state?: string;
  labels?: string[];
  headRefName?: string;
  baseRefName?: string;
}): string {
  return JSON.stringify({
    number: options.number,
    title: options.title ?? `PR ${options.number}`,
    headRefName: options.headRefName ?? `shipper/${options.number}-branch`,
    baseRefName: options.baseRefName ?? 'main',
    state: options.state ?? 'OPEN',
    labels: (options.labels ?? ['shipper:ready']).map((name) => ({ name })),
  });
}

describe('mergeCommand', () => {
  let fake: FakeCore;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let prComments: Array<{ pr: string; body: string }>;
  let mergedPrs: string[];
  let closedIssues: string[];

  const seedReadyPair = (
    prNumber = '42',
    issueNumber = '10',
    options: {
      body?: string;
      prLabels?: string[];
      issueLabels?: string[];
      headRefName?: string;
      baseRefName?: string;
    } = {}
  ): void => {
    fake.setIssue(issueNumber, { labels: options.issueLabels ?? ['shipper:ready'] });
    fake.setPr(prNumber, {
      body: options.body ?? `Closes #${issueNumber}`,
      labels: options.prLabels ?? ['shipper:ready'],
      headRefName: options.headRefName ?? `shipper/${issueNumber}-branch`,
      baseRefName: options.baseRefName ?? 'main',
    });
  };

  const stubPrViews = (
    views: Record<
      string,
      {
        title?: string;
        state?: string;
        labels?: string[];
        headRefName?: string;
        baseRefName?: string;
        mergeStateStatus?: string | string[];
        mergeable?: string;
      }
    >
  ): void => {
    const mergeStateIndexes = new Map<string, number>();
    fake.stubGh((args) => {
      if (args[0] !== 'pr' || args[1] !== 'view') {
        return undefined;
      }

      const ref = args[2];
      if (!ref) {
        return undefined;
      }

      const view = views[ref];
      if (!view) {
        return undefined;
      }

      const jsonIndex = args.indexOf('--json');
      const fields = jsonIndex === -1 ? undefined : args[jsonIndex + 1];

      if (fields === 'number,title,headRefName,baseRefName,state,labels') {
        return {
          stdout: prSummaryPayload({
            number: Number(ref),
            title: view.title,
            state: view.state,
            labels: view.labels,
            headRefName: view.headRefName,
            baseRefName: view.baseRefName,
          }),
          stderr: '',
        };
      }

      if (fields === 'mergeStateStatus') {
        const states = Array.isArray(view.mergeStateStatus)
          ? view.mergeStateStatus
          : [view.mergeStateStatus ?? 'CLEAN'];
        const index = mergeStateIndexes.get(ref) ?? 0;
        const mergeStateStatus = states[Math.min(index, states.length - 1)] ?? 'CLEAN';
        mergeStateIndexes.set(ref, index + 1);
        return {
          stdout: JSON.stringify({ mergeStateStatus }),
          stderr: '',
        };
      }

      if (fields === 'mergeStateStatus,mergeable') {
        const states = Array.isArray(view.mergeStateStatus)
          ? view.mergeStateStatus
          : [view.mergeStateStatus ?? 'CLEAN'];
        const index = mergeStateIndexes.get(ref) ?? 0;
        const mergeStateStatus = states[Math.min(index, states.length - 1)] ?? 'CLEAN';
        mergeStateIndexes.set(ref, index + 1);
        return {
          stdout: JSON.stringify({
            mergeStateStatus,
            mergeable: view.mergeable ?? 'MERGEABLE',
          }),
          stderr: '',
        };
      }

      return undefined;
    });
  };

  const stubMergeOperations = (): void => {
    fake.stubGh((args) => {
      if (args[0] === 'pr' && args[1] === 'merge' && args[2]) {
        mergedPrs.push(args[2]);
        return { stdout: `merged ${args[2]}`, stderr: '' };
      }

      if (args[0] === 'pr' && args[1] === 'comment' && args[2]) {
        prComments.push({
          pr: args[2],
          body: args.includes('--body') ? (args[args.indexOf('--body') + 1] ?? '') : '',
        });
        return { stdout: '', stderr: '' };
      }

      if (args[0] === 'issue' && args[1] === 'close' && args[2]) {
        closedIssues.push(args[2]);
        return { stdout: '', stderr: '' };
      }

      return undefined;
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    process.exitCode = undefined;
    prComments = [];
    mergedPrs = [];
    closedIssues = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubMergeOperations();
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake.dispose();
  });

  describe('lookupPR', () => {
    it('returns a queued PR for an open ready PR', async () => {
      seedReadyPair();
      stubPrViews({
        '42': {
          title: 'Test PR',
          headRefName: 'feat',
          baseRefName: 'main',
        },
      });

      await expect(lookupPR('42', repo)).resolves.toEqual({
        number: 42,
        title: 'Test PR',
        headRefName: 'feat',
        baseRefName: 'main',
        labeledAt: '',
      });
    });

    it('rejects PRs without shipper:ready', async () => {
      seedReadyPair('42', '10', { prLabels: ['shipper:pr-reviewed'] });
      stubPrViews({
        '42': {
          labels: ['shipper:pr-reviewed'],
        },
      });

      await expect(lookupPR('42', repo)).rejects.toThrow(
        'Error: PR #42 does not have the shipper:ready label.'
      );
    });

    it('resolves issue references through the real PR lookup path', async () => {
      seedReadyPair('99', '42');
      fake.stubGh((args) => {
        if (
          args[0] === 'pr' &&
          args[1] === 'view' &&
          args[2] === '42' &&
          args.includes('number,title,headRefName,baseRefName,state,labels')
        ) {
          throw new Error('not a PR');
        }

        if (args[0] === 'pr' && args[1] === 'list') {
          return {
            stdout: JSON.stringify([{ number: 99, headRefName: 'shipper/42-fix' }]),
            stderr: '',
          };
        }

        return undefined;
      });
      stubPrViews({
        '99': {
          title: 'Resolved PR',
          headRefName: 'shipper/42-fix',
        },
      });

      await expect(lookupPR('42', repo)).resolves.toEqual(
        expect.objectContaining({ number: 99, title: 'Resolved PR' })
      );
    });

    it('propagates shared validation errors for malformed payloads', async () => {
      fake.stubGh((args) => {
        if (
          args[0] === 'pr' &&
          args[1] === 'view' &&
          args[2] === '42' &&
          args.includes('number,title,headRefName,baseRefName,state,labels')
        ) {
          return {
            stdout: JSON.stringify({
              number: 42,
              title: 'Broken PR',
              headRefName: 'feat',
              baseRefName: 'main',
              state: 'OPEN',
              labels: [{}],
            }),
            stderr: '',
          };
        }

        return undefined;
      });

      await expect(lookupPR('42', repo)).rejects.toThrow(
        'gh returned an invalid PrViewForMerge payload: expected string at labels[0].name'
      );
    });
  });

  describe('mergeCommand', () => {
    it('rejects non-numeric PR or issue numbers', async () => {
      await expect(
        mergeCommand({ interval: '30', once: true, dryRun: false, number: 'abc', repo })
      ).rejects.toThrow('Error: argument must be a numeric issue or PR number.');
    });

    it('rejects invalid polling intervals', async () => {
      await expect(
        mergeCommand({ interval: 'abc', once: false, dryRun: false, repo })
      ).rejects.toThrow('Error: --interval must be a positive integer (seconds).');

      await expect(
        mergeCommand({ interval: '0', once: false, dryRun: false, repo })
      ).rejects.toThrow('Error: --interval must be a positive integer (seconds).');
    });

    it('merges a single ready PR through the real helper stack', async () => {
      seedReadyPair();
      stubPrViews({
        '42': {
          title: 'Ready PR',
          headRefName: 'feat',
          mergeStateStatus: 'CLEAN',
        },
      });
      fake.queueChecks('42', PASS_CHECKS);

      await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42', repo });

      expect(mergedPrs).toEqual(['42']);
      expect(closedIssues).toEqual(['10']);
      expect(fake.state.labelTransitions).toContainEqual({
        target: 'issue',
        number: '10',
        add: [],
        remove: ['shipper:ready'],
      });
      expect(fake.state.postedComments).toHaveLength(0);
      expect(process.exitCode).toBeUndefined();
    });

    it('fails and re-queues the PR when no linked issue can be determined', async () => {
      fake.setPr('42', {
        body: 'No linked issue here.',
        labels: ['shipper:ready'],
        headRefName: 'shipper/42-fix',
        baseRefName: 'main',
      });
      stubPrViews({
        '42': {
          title: 'Missing link',
          headRefName: 'shipper/42-fix',
        },
      });

      await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42', repo });

      expect(mergedPrs).toHaveLength(0);
      expect(fake.state.labelTransitions).toEqual(
        expect.arrayContaining([
          {
            target: 'pr',
            number: '42',
            add: [],
            remove: ['shipper:ready'],
          },
          {
            target: 'pr',
            number: '42',
            add: ['shipper:pr-reviewed'],
            remove: [],
          },
        ])
      );
      expect(prComments[0]?.body).toContain('Merge failed for PR #42.');
      expect(prComments[0]?.body).toContain(
        "Could not determine linked issue for PR #42. Add a closing reference such as 'Closes #123' to the PR body and re-queue it."
      );
      expect(process.exitCode).toBe(1);
    });

    it('logs queue context when the shared merge helper fails after remediation', async () => {
      seedReadyPair();
      stubPrViews({
        '42': {
          title: 'Conflicted PR',
          mergeStateStatus: 'DIRTY',
        },
      });

      await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42', repo });

      expect(errorSpy).toHaveBeenCalledWith(
        '[shipper]   Merge execution failed for PR #42; the shared merge helper already logged the detailed failure and applied remediation.'
      );
      expect(fake.state.labelTransitions).toEqual(
        expect.arrayContaining([
          {
            target: 'pr',
            number: '42',
            add: ['shipper:pr-reviewed'],
            remove: ['shipper:ready'],
          },
          {
            target: 'issue',
            number: '10',
            add: ['shipper:pr-reviewed'],
            remove: ['shipper:ready'],
          },
        ])
      );
      expect(prComments[0]?.body).toContain('merge conflicts');
      expect(process.exitCode).toBe(1);
    });

    it('keeps the dry-run BEHIND branch in merge.ts', async () => {
      seedReadyPair();
      stubPrViews({
        '42': {
          title: 'Behind PR',
          mergeStateStatus: 'BEHIND',
        },
      });

      await mergeCommand({ interval: '30', once: true, dryRun: true, number: '42', repo });

      expect(mergedPrs).toHaveLength(0);
      expect(logSpy).toHaveBeenCalledWith(
        '[shipper]   [dry-run] Would run: gh pr update-branch --rebase'
      );
      expect(process.exitCode).toBe(1);
    });

    it('runs dry-run post-merge cleanup without mutating labels', async () => {
      seedReadyPair();
      stubPrViews({
        '42': {
          title: 'Ready PR',
          mergeStateStatus: 'CLEAN',
        },
      });

      await mergeCommand({ interval: '30', once: true, dryRun: true, number: '42', repo });

      expect(mergedPrs).toHaveLength(0);
      expect(fake.state.labelTransitions).toHaveLength(0);
      expect(logSpy).toHaveBeenCalledWith(
        '[shipper]   [dry-run] Would merge PR #42 with --rebase --delete-branch'
      );
      expect(logSpy).toHaveBeenCalledWith(
        '[shipper]   [dry-run] Would remove shipper:ready and close issue #10'
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('processes queue-mode candidates FIFO and only merges the first PR', async () => {
      seedReadyPair('1', '77', { body: 'Closes #77', headRefName: 'shipper/1' });
      seedReadyPair('2', '88', { body: 'Closes #88', headRefName: 'shipper/2' });
      stubPrViews({
        '1': {
          title: 'First',
          mergeStateStatus: 'CLEAN',
          headRefName: 'shipper/1',
        },
      });
      fake.queueChecks('1', PASS_CHECKS);
      fake.stubGh((args) => {
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
                          {
                            createdAt: '2026-04-14T00:00:02Z',
                            label: { name: 'shipper:ready' },
                          },
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
                          {
                            createdAt: '2026-04-14T00:00:01Z',
                            label: { name: 'shipper:ready' },
                          },
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

        return undefined;
      });

      await mergeCommand({ interval: '30', once: true, dryRun: false, repo });

      expect(mergedPrs).toEqual(['1']);
      expect(closedIssues).toEqual(['77']);
      expect(fake.state.labelTransitions).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: 'issue',
            number: '88',
          }),
        ])
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('polls unknown merge states before proceeding', async () => {
      seedReadyPair();
      stubPrViews({
        '42': {
          title: 'Waiting PR',
          mergeStateStatus: ['UNKNOWN', 'UNKNOWN', 'CLEAN'],
          mergeable: 'UNKNOWN',
        },
      });
      fake.queueChecks('42', PASS_CHECKS);

      await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42', repo });

      expect(fake.state.sleepCalls).toEqual([3000, 3000]);
      expect(mergedPrs).toEqual(['42']);
      expect(process.exitCode).toBeUndefined();
    });

    it('warns and retries later when required checks are still pending', async () => {
      seedReadyPair();
      stubPrViews({
        '42': {
          title: 'Pending PR',
          mergeStateStatus: 'CLEAN',
        },
      });
      fake.queueChecks('42', [
        {
          name: 'build',
          state: 'IN_PROGRESS',
          bucket: 'pending',
          link: 'https://github.com/owner/repo/actions/runs/123',
        },
      ]);

      await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42', repo });

      expect(mergedPrs).toHaveLength(0);
      expect(closedIssues).toHaveLength(0);
      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(
        '[shipper] PR #42 has pending CI checks: build. Retry when they complete.'
      );
      expect(prComments).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
