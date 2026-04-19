import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunPromptOpts } from '@dnsquared/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

const repo = 'owner/repo';
const diffFixture = [
  'diff --git a/src/file.ts b/src/file.ts',
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1,3 +1,4 @@',
  ' line 1',
  ' line 2',
  ' line 3',
  '+line 4',
].join('\n');

function buildIssueList(
  issueNumber: string,
  title: string,
  labels: string[]
): Array<{ number: number; title: string; labels: Array<{ name: string }> }> {
  return [
    {
      number: Number(issueNumber),
      title,
      labels: labels.map((name) => ({ name })),
    },
  ];
}

describe('prReviewCommand', () => {
  let fake: FakeCore;
  let promptCalls: Array<{ name: string; opts: RunPromptOpts }>;

  const stubPrFilesAndMetadata = (issueNumber: string, prNumber: string): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'api' &&
        args[1] === `repos/${repo}/pulls/${prNumber}/files` &&
        args.includes('--paginate') &&
        args.includes('--slurp')
      ) {
        return {
          stdout: '[[{"filename":"src/file.ts"}]]',
          stderr: '',
        };
      }

      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args[2] === prNumber &&
        args.includes('--json') &&
        args.includes('headRefOid,author,title,headRefName')
      ) {
        return {
          stdout: JSON.stringify({
            headRefOid: 'abc123',
            author: { login: 'review-author' },
            title: `PR ${prNumber}`,
            headRefName: `shipper/${issueNumber}-feature`,
          }),
          stderr: '',
        };
      }

      return undefined;
    });
  };

  const stubAutoSelectPr = (issueNumber: string, title: string, prNumber: string): void => {
    fake.stubGh((args) => {
      if (args[0] !== 'issue' || args[1] !== 'list' || !args.includes('-R')) {
        return undefined;
      }

      const labels = args.flatMap((arg, index) =>
        arg === '--label' && args[index + 1] ? [String(args[index + 1])] : []
      );
      if (!labels.includes('shipper:pr-open')) {
        return undefined;
      }

      if (labels.includes('shipper:locked')) {
        return { stdout: '[]', stderr: '' };
      }

      return {
        stdout: JSON.stringify(buildIssueList(issueNumber, title, ['shipper:pr-open'])),
        stderr: '',
      };
    });

    fake.stubGh((args) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'list' &&
        args.includes('--state') &&
        args.includes('open') &&
        args.includes('--json') &&
        args.includes('number,headRefName')
      ) {
        return {
          stdout: JSON.stringify([
            { number: Number(prNumber), headRefName: `shipper/${issueNumber}-feature` },
          ]),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  const readInputFile = async (filename: string): Promise<string> => {
    return await readFile(path.join(fake.wtPath(), '.shipper', 'input', filename), 'utf-8');
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('writes real review context files and advances the issue and PR to pr-reviewed', async () => {
    fake.setIssue('10', { labels: ['shipper:pr-open'], title: 'Review issue' });
    fake.setPr('42', {
      labels: ['shipper:pr-open'],
      body: 'Closes #10',
      diff: diffFixture,
      headRefName: 'shipper/10-feature',
    });
    stubPrFilesAndMetadata('10', '42');
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: {
          verdict: 'accept',
          comment: '.shipper/output/comment-10.md',
        },
        commentBody: 'PR review complete.',
        reviewPayload: {
          payload: {
            commit_id: 'abc123',
            body: 'Looks good.',
            event: 'COMMENT',
            comments: [],
          },
        },
      });
      return 0;
    });

    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(0);
    expect(promptCalls).toEqual([
      {
        name: 'pr_review',
        opts: {
          repo,
          issueRef: '10',
          prRef: '42',
          cwd: fake.wtPath(),
          mode: undefined,
          agent: undefined,
          model: undefined,
        },
      },
    ]);
    await expect(readInputFile('pr-diff.patch')).resolves.toBe(diffFixture);
    await expect(readInputFile('pr-files.json')).resolves.toBe('[{"filename":"src/file.ts"}]');
    await expect(readInputFile('pr-metadata.json')).resolves.toBe(
      JSON.stringify({
        headRefOid: 'abc123',
        author: { login: 'review-author' },
        title: 'PR 42',
        headRefName: 'shipper/10-feature',
      })
    );
    expect(fake.state.submittedReviews).toHaveLength(1);
    expect(fake.state.submittedReviews[0]?.pr).toBe('42');
    expect(fake.state.postedComments).toEqual([
      { target: 'issue', number: '10', body: 'PR review complete.' },
    ]);
    expect(fake.state.labelTransitions).toEqual(
      expect.arrayContaining([
        { target: 'issue', number: '10', add: ['shipper:locked'], remove: [] },
        {
          target: 'issue',
          number: '10',
          add: ['shipper:pr-reviewed'],
          remove: ['shipper:pr-open'],
        },
        {
          target: 'pr',
          number: '42',
          add: ['shipper:pr-reviewed'],
          remove: ['shipper:pr-open'],
        },
        { target: 'issue', number: '10', add: [], remove: ['shipper:locked'] },
      ])
    );
  });

  it('auto-selects a PR that is ready for review when none is provided', async () => {
    fake.setIssue('321', { labels: ['shipper:pr-open'], title: 'Selected issue' });
    fake.setPr('84', {
      labels: ['shipper:pr-open'],
      body: 'Closes #321',
      diff: diffFixture,
      headRefName: 'shipper/321-feature',
    });
    stubAutoSelectPr('321', 'Selected issue', '84');
    stubPrFilesAndMetadata('321', '84');
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-321.md' },
        commentBody: 'PR review complete.',
        reviewPayload: {
          payload: {
            commit_id: 'abc123',
            body: 'Looks good.',
            event: 'COMMENT',
            comments: [],
          },
        },
      });
      return 0;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo)).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts).toEqual(
      expect.objectContaining({
        issueRef: '321',
        prRef: '84',
      })
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Auto-selected PR #84'));
  });

  it('reports a crashed agent run at the CLI boundary', async () => {
    fake.setIssue('10', { labels: ['shipper:pr-open'], title: 'Review issue' });
    fake.setPr('42', {
      labels: ['shipper:pr-open'],
      body: 'Closes #10',
      diff: diffFixture,
      headRefName: 'shipper/10-feature',
    });
    stubPrFilesAndMetadata('10', '42');
    fake.scriptRunPrompt(() => 21);

    const { prReviewCommand } = await import('../../src/commands/pr-review.js');

    await expect(prReviewCommand(repo, '42')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(fake.state.postedComments.at(-1)?.body).toContain('The `pr_review` agent run exited');
    expect(fake.state.issues.get('10')?.labels).toEqual(new Set(['shipper:pr-open']));
    expect(fake.state.submittedReviews).toEqual([]);
  });
});
