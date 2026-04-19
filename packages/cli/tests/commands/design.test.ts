import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunPromptOpts } from '@dnsquared/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

const repo = 'owner/repo';

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

describe('designCommand', () => {
  let fake: FakeCore;
  let promptCalls: Array<{ name: string; opts: RunPromptOpts }>;

  const stubDefaultBranch = (branch = 'main'): void => {
    fake.stubGh((args) => {
      if (args[0] === 'repo' && args[1] === 'view' && args[2] === repo) {
        return { stdout: `${branch}\n`, stderr: '' };
      }
      return undefined;
    });
  };

  const stubAutoSelectIssue = (issueNumber: string, title: string): void => {
    fake.stubGh((args) => {
      if (args[0] !== 'issue' || args[1] !== 'list' || !args.includes('-R')) {
        return undefined;
      }

      const labels = args.flatMap((arg, index) =>
        arg === '--label' && args[index + 1] ? [String(args[index + 1])] : []
      );
      if (!labels.includes('shipper:groomed')) {
        return undefined;
      }

      if (labels.includes('shipper:locked')) {
        return { stdout: '[]', stderr: '' };
      }

      return {
        stdout: JSON.stringify(buildIssueList(issueNumber, title, ['shipper:groomed'])),
        stderr: '',
      };
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    process.exitCode = undefined;
    stubDefaultBranch();
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('runs the real design stage and advances the issue to designed', async () => {
    fake.setIssue('123', { labels: ['shipper:groomed'], title: 'Design issue' });
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-123.md' },
        commentBody: 'Design accepted.',
      });
      return 0;
    });

    const { designCommand } = await import('../../src/commands/design.js');

    await expect(designCommand(repo, '123')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(0);
    expect(promptCalls).toEqual([
      {
        name: 'design',
        opts: {
          repo,
          issueRef: '123',
          cwd: fake.wtPath(),
          mode: undefined,
          agent: undefined,
          model: undefined,
        },
      },
    ]);
    expect(fake.state.postedComments).toEqual([
      { target: 'issue', number: '123', body: 'Design accepted.' },
    ]);
    expect(fake.state.labelTransitions).toEqual(
      expect.arrayContaining([
        { target: 'issue', number: '123', add: ['shipper:locked'], remove: [] },
        {
          target: 'issue',
          number: '123',
          add: ['shipper:designed'],
          remove: ['shipper:groomed'],
        },
        { target: 'issue', number: '123', add: [], remove: ['shipper:locked'] },
      ])
    );
    expect(fake.state.issues.get('123')?.labels).toEqual(new Set(['shipper:designed']));
  });

  it('auto-selects a groomed issue when none is provided', async () => {
    fake.setIssue('321', { labels: ['shipper:groomed'], title: 'Selected issue' });
    stubAutoSelectIssue('321', 'Selected issue');
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-321.md' },
        commentBody: 'Design accepted.',
      });
      return 0;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { designCommand } = await import('../../src/commands/design.js');

    await expect(designCommand(repo)).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts.issueRef).toBe('321');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Auto-selected #321'));
  });

  it('reports a crashed agent run at the CLI boundary', async () => {
    fake.setIssue('123', { labels: ['shipper:groomed'], title: 'Design issue' });
    fake.scriptRunPrompt(() => 9);

    const { designCommand } = await import('../../src/commands/design.js');

    await expect(designCommand(repo, '123')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(fake.state.postedComments.at(-1)?.body).toContain('The `design` agent run exited');
    expect(fake.state.issues.get('123')?.labels).toEqual(new Set(['shipper:groomed']));
  });
});
