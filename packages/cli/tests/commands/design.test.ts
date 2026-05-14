import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@baremetallabs-ai/shipper-core';
import type { RunPromptOpts } from '@baremetallabs-ai/shipper-core';

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
  let savedDesignAdversaryFlag: string | undefined;

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
    savedDesignAdversaryFlag = process.env[core.DESIGN_ADVERSARY_FLAG];
    Reflect.deleteProperty(process.env, core.DESIGN_ADVERSARY_FLAG);
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    process.exitCode = undefined;
    stubDefaultBranch();
  });

  afterEach(async () => {
    if (savedDesignAdversaryFlag === undefined) {
      Reflect.deleteProperty(process.env, core.DESIGN_ADVERSARY_FLAG);
    } else {
      process.env[core.DESIGN_ADVERSARY_FLAG] = savedDesignAdversaryFlag;
    }
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

  it('keeps a successful interactive stage result and label transition after a buffered renewal failure', async () => {
    vi.useFakeTimers();
    try {
      fake.setIssue('123', { labels: ['shipper:groomed'], title: 'Design issue' });
      let lockRemoveAttempts = 0;
      fake.stubGh((args) => {
        if (
          args[0] === 'issue' &&
          args[1] === 'edit' &&
          args[2] === '123' &&
          args.includes('--remove-label') &&
          args.includes('shipper:locked')
        ) {
          lockRemoveAttempts += 1;
          if (lockRemoveAttempts === 1) {
            throw fake.makeGhError(args, { stderr: 'gh: renewal failed (HTTP 404)' });
          }
        }
        return undefined;
      });

      let markPromptStarted!: () => void;
      const promptStarted = new Promise<void>((resolve) => {
        markPromptStarted = resolve;
      });
      let finishPrompt!: () => void;
      const promptBlocker = new Promise<void>((resolve) => {
        finishPrompt = resolve;
      });
      fake.scriptRunPrompt(async (name, opts) => {
        promptCalls.push({ name, opts });
        markPromptStarted();
        await promptBlocker;
        await fake.writeStageOutput({
          result: { verdict: 'accept', comment: '.shipper/output/comment-123.md' },
          commentBody: 'Design accepted after renewal failure.',
        });
        return 0;
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const errorMessages = (): string[] => errorSpy.mock.calls.map(([message]) => String(message));

      const { runDesignStage } = await import('../../src/commands/design.js');

      const resultPromise = runDesignStage(repo, '123', 'interactive');
      await promptStarted;
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(
        errorMessages().filter((message) => message.includes('lock renewal failed'))
      ).toHaveLength(0);

      finishPrompt();
      await expect(resultPromise).resolves.toEqual({
        success: true,
        exitCode: 0,
        verdict: 'accept',
      });

      const renewalMessages = errorMessages().filter((message) => message.includes('lock renewal'));
      expect(renewalMessages).toHaveLength(1);
      expect(renewalMessages[0]).toContain('1 lock renewal failure');
      expect(renewalMessages[0]).toContain('gh: renewal failed (HTTP 404)');
      expect(fake.state.labelTransitions).toEqual(
        expect.arrayContaining([
          {
            target: 'issue',
            number: '123',
            add: ['shipper:designed'],
            remove: ['shipper:groomed'],
          },
        ])
      );
      expect(fake.state.issues.get('123')?.labels).toEqual(new Set(['shipper:designed']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('enables buffered lock renewal output when design resolves to interactive mode', async () => {
    const resolveModeSpy = vi.spyOn(core, 'resolveMode').mockReturnValue('interactive');
    const scaffoldSpy = vi
      .spyOn(core, 'runStageScaffold')
      .mockResolvedValue({ success: true, exitCode: 0 });

    const { runDesignStage } = await import('../../src/commands/design.js');

    await expect(runDesignStage(repo, '123', 'default')).resolves.toEqual({
      success: true,
      exitCode: 0,
    });

    expect(resolveModeSpy).toHaveBeenCalledWith('design', 'default');
    expect(scaffoldSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'design',
        resultStage: 'design',
        bufferLockRenewalOutput: true,
      })
    );
  });

  it('does not enable buffered lock renewal output when design resolves to headless mode', async () => {
    vi.spyOn(core, 'resolveMode').mockReturnValue('headless');
    const scaffoldSpy = vi
      .spyOn(core, 'runStageScaffold')
      .mockResolvedValue({ success: true, exitCode: 0 });

    const { runDesignStage } = await import('../../src/commands/design.js');

    await expect(runDesignStage(repo, '123', 'headless')).resolves.toEqual({
      success: true,
      exitCode: 0,
    });

    expect(scaffoldSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        bufferLockRenewalOutput: false,
      })
    );
  });
});
