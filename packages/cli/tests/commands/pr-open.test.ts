import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as core from '@baremetallabs-ai/shipper-core';
import { runPrompt } from '@baremetallabs-ai/shipper-core';
import type { RunPromptOpts } from '@baremetallabs-ai/shipper-core';

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
  promptName: 'pr_open';
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

describe('prOpenCommand', () => {
  let fake: FakeCore;
  let promptCalls: Array<{ name: string; opts: RunPromptOpts }>;
  let findBranchForIssueSpy: MockInstance;
  let transportInvokerSpy: MockInstance;

  const toRunPromptOpts = (
    baseRunPromptOpts: BaseTransportPromptOpts,
    wtPath: string,
    userInput?: string
  ): RunPromptOpts => ({
    repo: baseRunPromptOpts.repo,
    issueRef: baseRunPromptOpts.issueRef,
    cwd: wtPath,
    ...('mode' in baseRunPromptOpts ? { mode: baseRunPromptOpts.mode } : {}),
    ...('agent' in baseRunPromptOpts ? { agent: baseRunPromptOpts.agent } : {}),
    ...('model' in baseRunPromptOpts ? { model: baseRunPromptOpts.model } : {}),
    ...('baseBranch' in baseRunPromptOpts ? { baseBranch: baseRunPromptOpts.baseBranch } : {}),
    userInput,
  });

  const createTransportInvoker = (args: TransportInvokerArgs): StageInvokerFactory => {
    const { baseRunPromptOpts } = args;

    return ({ wtPath }) => ({
      initial: () => runPrompt('pr_open', toRunPromptOpts(baseRunPromptOpts, wtPath)),
      retry: (userInput) =>
        runPrompt('pr_open', toRunPromptOpts(baseRunPromptOpts, wtPath, userInput)),
    });
  };

  const stubDefaultBranch = (branch = 'release/2026'): void => {
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
      if (!labels.includes('shipper:implemented')) {
        return undefined;
      }

      if (labels.includes('shipper:locked')) {
        return { stdout: '[]', stderr: '' };
      }

      return {
        stdout: JSON.stringify(buildIssueList(issueNumber, title, ['shipper:implemented'])),
        stderr: '',
      };
    });
  };

  const stubOpenPrSearch = (prs: Array<{ number: number; headRefName: string }>): void => {
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
          stdout: JSON.stringify(prs),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  const stubIssueRefLookup = (issueNumber: string): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args[2] === issueNumber &&
        args.includes('--json') &&
        args.includes('number,body')
      ) {
        throw new Error('not a pull request');
      }
      return undefined;
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    process.exitCode = undefined;
    stubDefaultBranch();
    // findBranchForIssue shells out to git and is not covered by fake transports.
    findBranchForIssueSpy = vi
      .spyOn(core, 'findBranchForIssue')
      .mockResolvedValue('shipper/239-branch');
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

  it('creates a PR from stage output and mirrors the pr-open transition', async () => {
    fake.setIssue('239', { labels: ['shipper:implemented'], title: 'Open PR issue' });
    stubIssueRefLookup('239');
    stubOpenPrSearch([]);
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: {
          verdict: 'accept',
          comment: '.shipper/output/comment-239.md',
        },
        commentBody: 'PR opened.',
        prSpec: {
          body: 'Implements the planned change.',
          title: 'Implement issue 239',
          base: 'release/2026',
          headBranch: 'shipper/239-branch',
        },
      });
      return 0;
    });

    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand(repo, '239')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(0);
    expect(findBranchForIssueSpy).toHaveBeenCalledWith('239');
    expect(transportInvokerSpy).toHaveBeenCalledWith({
      promptName: 'pr_open',
      pushMode: 'force-with-lease',
      baseRunPromptOpts: {
        repo,
        issueRef: '239',
        baseBranch: 'release/2026',
        mode: undefined,
        agent: undefined,
        model: undefined,
      },
    });
    expect(promptCalls).toEqual([
      {
        name: 'pr_open',
        opts: {
          repo,
          issueRef: '239',
          baseBranch: 'release/2026',
          cwd: fake.wtPath(),
          mode: undefined,
          agent: undefined,
          model: undefined,
          userInput: undefined,
        },
      },
    ]);
    expect(fake.state.createdPrs).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/1',
        head: 'shipper/239-branch',
        base: 'release/2026',
        title: 'Implement issue 239',
        draft: false,
        body: 'Implements the planned change.',
      },
    ]);
    expect(fake.state.labelTransitions).toEqual(
      expect.arrayContaining([
        { target: 'issue', number: '239', add: ['shipper:locked'], remove: [] },
        {
          target: 'issue',
          number: '239',
          add: ['shipper:pr-open'],
          remove: ['shipper:implemented'],
        },
        {
          target: 'pr',
          number: '1',
          add: ['shipper:pr-open'],
          remove: ['shipper:implemented'],
        },
        { target: 'issue', number: '239', add: [], remove: ['shipper:locked'] },
      ])
    );
  });

  it('reuses an existing PR instead of creating another one', async () => {
    fake.setIssue('239', { labels: ['shipper:implemented'], title: 'Open PR issue' });
    stubIssueRefLookup('239');
    fake.setPr('84', {
      headRefName: 'shipper/239-branch',
      labels: ['shipper:implemented'],
    });
    stubOpenPrSearch([{ number: 84, headRefName: 'shipper/239-branch' }]);
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: {
          verdict: 'accept',
          comment: '.shipper/output/comment-239.md',
        },
        commentBody: 'PR already open.',
        prSpec: {
          body: 'Existing PR body.',
          title: 'Implement issue 239',
          base: 'release/2026',
          headBranch: 'shipper/239-branch',
        },
      });
      return 0;
    });

    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand(repo, '239')).resolves.toBeUndefined();

    expect(fake.state.createdPrs).toEqual([]);
    expect(fake.state.labelTransitions).toEqual(
      expect.arrayContaining([
        {
          target: 'pr',
          number: '84',
          add: ['shipper:pr-open'],
          remove: ['shipper:implemented'],
        },
      ])
    );
  });

  it('auto-selects an implemented issue when none is provided', async () => {
    fake.setIssue('321', { labels: ['shipper:implemented'], title: 'Selected issue' });
    stubAutoSelectIssue('321', 'Selected issue');
    // Auto-selected issue uses a different branch lookup than the default test issue.
    findBranchForIssueSpy.mockResolvedValueOnce('shipper/321-branch');
    stubOpenPrSearch([]);
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-321.md' },
        commentBody: 'PR opened.',
        prSpec: {
          body: 'Autoselected PR body.',
          title: 'Selected issue',
          base: 'release/2026',
          headBranch: 'shipper/321-branch',
        },
      });
      return 0;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand(repo)).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts.issueRef).toBe('321');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Auto-selected #321'));
  });

  it('propagates transport-stage agent exit codes to the CLI boundary', async () => {
    fake.setIssue('239', { labels: ['shipper:implemented'], title: 'Open PR issue' });
    stubIssueRefLookup('239');
    stubOpenPrSearch([]);
    fake.scriptRunPrompt(() => 19);

    const { prOpenCommand } = await import('../../src/commands/pr-open.js');

    await expect(prOpenCommand(repo, '239')).resolves.toBeUndefined();

    expect(process.exitCode).toBe(19);
    expect(fake.state.createdPrs).toEqual([]);
    expect(fake.state.postedComments).toEqual([]);
  });

  it('enables buffered lock renewal output when pr_open resolves to interactive mode', async () => {
    stubOpenPrSearch([]);
    const resolveModeSpy = vi.spyOn(core, 'resolveMode').mockReturnValue('interactive');
    const scaffoldSpy = vi
      .spyOn(core, 'runStageScaffold')
      .mockResolvedValue({ success: true, exitCode: 0 });

    const { runPrOpenStage } = await import('../../src/commands/pr-open.js');

    await expect(runPrOpenStage(repo, '239', 'default')).resolves.toEqual({
      success: true,
      exitCode: 0,
    });

    expect(resolveModeSpy).toHaveBeenCalledWith('pr_open', 'default');
    expect(scaffoldSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'pr-open',
        resultStage: 'pr_open',
        initialFailure: 'propagate',
        bufferLockRenewalOutput: true,
      })
    );
  });
});
