import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@dnsquared/shipper-core';
import { runPrompt } from '@dnsquared/shipper-core';
import type { RunPromptOpts } from '@dnsquared/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;
type BaseTransportPromptOpts = {
  repo: string;
  issueRef: string;
  mode?: 'headless' | 'interactive' | 'default';
  agent?: 'claude' | 'codex' | 'copilot';
  model?: string;
  baseBranch?: string;
};
type TransportInvokerArgs = {
  promptName: 'implement';
  pushMode: 'new-branch' | 'force-with-lease';
  baseRunPromptOpts: BaseTransportPromptOpts;
};
type StageInvocation = {
  initial: () => Promise<number>;
  retry: (userInput: string) => Promise<number>;
};
type StageInvokerFactory = (ctx: { wtPath: string }) => StageInvocation;

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

describe('implementCommand', () => {
  let fake: FakeCore;
  let promptCalls: Array<{ name: string; opts: RunPromptOpts }>;
  let transportInvokerSpy: ReturnType<typeof vi.spyOn>;

  const toRunPromptOpts = (
    baseRunPromptOpts: BaseTransportPromptOpts,
    wtPath: string,
    userInput?: string
  ): RunPromptOpts => ({
    repo: baseRunPromptOpts.repo,
    issueRef: baseRunPromptOpts.issueRef,
    cwd: wtPath,
    ...(baseRunPromptOpts.mode === undefined ? {} : { mode: baseRunPromptOpts.mode }),
    ...(baseRunPromptOpts.agent === undefined ? {} : { agent: baseRunPromptOpts.agent }),
    ...(baseRunPromptOpts.model === undefined ? {} : { model: baseRunPromptOpts.model }),
    ...(baseRunPromptOpts.baseBranch === undefined
      ? {}
      : { baseBranch: baseRunPromptOpts.baseBranch }),
    ...(userInput === undefined ? {} : { userInput }),
  });

  const createTransportInvoker = (args: TransportInvokerArgs): StageInvokerFactory => {
    const { baseRunPromptOpts } = args;

    return ({ wtPath }) => ({
      initial: () => runPrompt('implement', toRunPromptOpts(baseRunPromptOpts, wtPath)),
      retry: (userInput) =>
        runPrompt('implement', toRunPromptOpts(baseRunPromptOpts, wtPath, userInput)),
    });
  };

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
      if (!labels.includes('shipper:planned')) {
        return undefined;
      }

      if (labels.includes('shipper:locked')) {
        return { stdout: '[]', stderr: '' };
      }

      return {
        stdout: JSON.stringify(buildIssueList(issueNumber, title, ['shipper:planned'])),
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
    // transportInvoker still shells out through withGitTransport, which fakeCore does not seam.
    const mockTransportInvoker = (args: TransportInvokerArgs): StageInvokerFactory =>
      createTransportInvoker(args);
    transportInvokerSpy = vi
      .spyOn(core, 'transportInvoker')
      .mockImplementation(mockTransportInvoker as never);
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('runs the real implement stage and advances the issue to implemented', async () => {
    fake.setIssue('239', { labels: ['shipper:planned'], title: 'Implement issue' });
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-239.md' },
        commentBody: 'Implementation accepted.',
      });
      return 0;
    });

    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand(repo, '239')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(0);
    expect(transportInvokerSpy).toHaveBeenCalledWith({
      promptName: 'implement',
      pushMode: 'new-branch',
      baseRunPromptOpts: {
        repo,
        issueRef: '239',
        mode: undefined,
        agent: undefined,
        model: undefined,
      },
    });
    expect(promptCalls).toEqual([
      {
        name: 'implement',
        opts: {
          repo,
          issueRef: '239',
          cwd: fake.wtPath(),
          mode: undefined,
          agent: undefined,
          model: undefined,
          userInput: undefined,
        },
      },
    ]);
    expect(fake.state.postedComments).toEqual([
      { target: 'issue', number: '239', body: 'Implementation accepted.' },
    ]);
    expect(fake.state.labelTransitions).toEqual(
      expect.arrayContaining([
        { target: 'issue', number: '239', add: ['shipper:locked'], remove: [] },
        {
          target: 'issue',
          number: '239',
          add: ['shipper:implemented'],
          remove: ['shipper:planned'],
        },
        { target: 'issue', number: '239', add: [], remove: ['shipper:locked'] },
      ])
    );
    expect(fake.state.issues.get('239')?.labels).toEqual(new Set(['shipper:implemented']));
  });

  it('auto-selects a planned issue when none is provided', async () => {
    fake.setIssue('321', { labels: ['shipper:planned'], title: 'Selected issue' });
    stubAutoSelectIssue('321', 'Selected issue');
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-321.md' },
        commentBody: 'Implementation accepted.',
      });
      return 0;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand(repo)).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts.issueRef).toBe('321');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Auto-selected #321'));
  });

  it('propagates transport-stage agent exit codes to the CLI boundary', async () => {
    fake.setIssue('239', { labels: ['shipper:planned'], title: 'Implement issue' });
    fake.scriptRunPrompt(() => 17);

    const { implementCommand } = await import('../../src/commands/implement.js');

    await expect(implementCommand(repo, '239')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(17);
    expect(fake.state.postedComments).toEqual([]);
    expect(fake.state.issues.get('239')?.labels).toEqual(new Set(['shipper:planned']));
  });
});
