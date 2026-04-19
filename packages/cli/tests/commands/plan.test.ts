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

describe('planCommand', () => {
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
      if (!labels.includes('shipper:designed')) {
        return undefined;
      }

      if (labels.includes('shipper:locked')) {
        return { stdout: '[]', stderr: '' };
      }

      return {
        stdout: JSON.stringify(buildIssueList(issueNumber, title, ['shipper:designed'])),
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

  it('runs the real planning stage and advances the issue to planned', async () => {
    fake.setIssue('123', { labels: ['shipper:designed'], title: 'Planning issue' });
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-123.md' },
        commentBody: 'Plan accepted.',
      });
      return 0;
    });

    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand(repo, '123')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(0);
    expect(promptCalls).toEqual([
      {
        name: 'plan',
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
      { target: 'issue', number: '123', body: 'Plan accepted.' },
    ]);
    expect(fake.state.labelTransitions).toEqual(
      expect.arrayContaining([
        { target: 'issue', number: '123', add: ['shipper:locked'], remove: [] },
        {
          target: 'issue',
          number: '123',
          add: ['shipper:planned'],
          remove: ['shipper:designed'],
        },
        { target: 'issue', number: '123', add: [], remove: ['shipper:locked'] },
      ])
    );
    expect(fake.state.issues.get('123')?.labels).toEqual(new Set(['shipper:planned']));
  });

  it('auto-selects a designed issue when none is provided', async () => {
    fake.setIssue('321', { labels: ['shipper:designed'], title: 'Selected issue' });
    stubAutoSelectIssue('321', 'Selected issue');
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-321.md' },
        commentBody: 'Plan accepted.',
      });
      return 0;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand(repo)).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts.issueRef).toBe('321');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Auto-selected #321'));
  });

  it('reports a crashed agent run at the CLI boundary', async () => {
    fake.setIssue('123', { labels: ['shipper:designed'], title: 'Planning issue' });
    fake.scriptRunPrompt(() => 11);

    const { planCommand } = await import('../../src/commands/plan.js');

    await expect(planCommand(repo, '123')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(fake.state.postedComments.at(-1)?.body).toContain('The `plan` agent run exited');
    expect(fake.state.issues.get('123')?.labels).toEqual(new Set(['shipper:designed']));
  });
});
