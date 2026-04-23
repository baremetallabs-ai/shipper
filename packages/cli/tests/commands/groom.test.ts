import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@dnsquared/shipper-core';
import type { RunPromptOpts } from '@dnsquared/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

const printAutoSummaryMock = vi.fn();
const repo = 'owner/repo';
const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

vi.mock('../../src/commands/ship-auto.js', () => ({
  printAutoSummary: printAutoSummaryMock,
}));

function setStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value,
  });
}

function restoreStdinIsTTY(): void {
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
    return;
  }

  Reflect.deleteProperty(process.stdin, 'isTTY');
}

describe('groomCommand', () => {
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

  const stubAutoSelectIssues = (queued: Array<{ number: string; title: string }>): void => {
    fake.stubGh((args) => {
      if (args[0] !== 'issue' || args[1] !== 'list' || !args.includes('-R')) {
        return undefined;
      }

      const labels = args.flatMap((arg, index) =>
        arg === '--label' && args[index + 1] ? [String(args[index + 1])] : []
      );
      if (!labels.includes('shipper:new')) {
        return undefined;
      }

      if (labels.includes('shipper:locked')) {
        return { stdout: '[]', stderr: '' };
      }

      const next = queued.shift();
      return {
        stdout: next
          ? JSON.stringify([
              {
                number: Number(next.number),
                title: next.title,
                labels: [{ name: 'shipper:new' }],
              },
            ])
          : '[]',
        stderr: '',
      };
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    process.exitCode = undefined;
    setStdinIsTTY(true);
    stubDefaultBranch();
  });

  afterEach(async () => {
    process.exitCode = undefined;
    restoreStdinIsTTY();
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('runs a single issue inside a fake worktree on the generated branch', async () => {
    fake.setIssue('123', { labels: ['shipper:new'], title: 'Single issue' });
    fake.scriptRunPrompt((name, opts) => {
      promptCalls.push({ name, opts });
      return 0;
    });

    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand(repo, '123')).resolves.toBeUndefined();

    expect(promptCalls).toEqual([
      {
        name: 'groom',
        opts: {
          repo,
          issueRef: '123',
          cwd: fake.wtPath(),
          mode: undefined,
          agent: undefined,
          model: undefined,
          disableMcp: undefined,
        },
      },
    ]);
    expect(fake.state.labelTransitions).toEqual([
      { target: 'issue', number: '123', add: ['shipper:locked'], remove: [] },
      { target: 'issue', number: '123', add: [], remove: ['shipper:locked'] },
    ]);
    expect(process.exitCode).toBe(0);
  });

  it('creates a separate fake worktree for each issue in auto mode', async () => {
    fake.setIssue('101', { labels: ['shipper:new'], title: 'First issue' });
    fake.setIssue('102', { labels: ['shipper:new'], title: 'Second issue' });
    stubAutoSelectIssues([
      { number: '101', title: 'First issue' },
      { number: '102', title: 'Second issue' },
    ]);
    fake.scriptRunPrompt((name, opts) => {
      promptCalls.push({ name, opts });
      return 0;
    });

    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand(repo, undefined, { auto: true })).resolves.toBeUndefined();

    expect(promptCalls.map((call) => call.opts.issueRef)).toEqual(['101', '102']);
    expect(promptCalls.every((call) => call.opts.cwd === fake.wtPath())).toBe(true);
    expect(printAutoSummaryMock).toHaveBeenCalledWith([
      { issue: 101, title: 'First issue', outcome: 'pass', error: undefined },
      { issue: 102, title: 'Second issue', outcome: 'pass', error: undefined },
    ]);
    expect(process.exitCode).toBe(0);
  });

  it('forwards disableMcp into the groom prompt invocation', async () => {
    fake.setIssue('123', { labels: ['shipper:new'], title: 'Single issue' });
    fake.scriptRunPrompt((name, opts) => {
      promptCalls.push({ name, opts });
      return 0;
    });

    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(
      groomCommand(repo, '123', { auto: false, disableMcp: true })
    ).resolves.toBeUndefined();

    expect(promptCalls[0]?.opts.disableMcp).toBe(true);
  });

  it('throws explicitly headless grooming before doing any work', async () => {
    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand(repo, '123', { auto: false, mode: 'headless' })).rejects.toThrow(
      'Error: groom does not support headless mode. Grooming requires interactive input.'
    );
    expect(promptCalls).toEqual([]);
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('throws settings-resolved headless grooming before doing any work', async () => {
    // resolveMode depends on settings/module state and is not covered by fake transports.
    vi.spyOn(core, 'resolveMode').mockReturnValueOnce('headless');

    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand(repo, '123', { auto: false })).rejects.toThrow(
      'Error: groom does not support headless mode. Grooming requires interactive input.'
    );
    expect(promptCalls).toEqual([]);
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('throws for non-interactive single-issue grooming before doing any work', async () => {
    setStdinIsTTY(false);
    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand(repo, '123', { auto: false })).rejects.toThrow(
      'Error: shipper groom requires an interactive terminal. stdin is not a TTY.'
    );
    expect(promptCalls).toEqual([]);
    expect(printAutoSummaryMock).not.toHaveBeenCalled();
  });

  it('throws for non-interactive auto grooming before the auto loop starts', async () => {
    setStdinIsTTY(false);
    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand(repo, undefined, { auto: true })).rejects.toThrow(
      'Error: shipper groom requires an interactive terminal. stdin is not a TTY.'
    );
    expect(promptCalls).toEqual([]);
    expect(printAutoSummaryMock).not.toHaveBeenCalled();
  });

  it('fails hard when worktree setup fails', async () => {
    fake.setIssue('123', { labels: ['shipper:new'], title: 'Single issue' });
    // This one-off spy forces the worktree failure branch, which fakeCore does not script directly.
    vi.spyOn(core, 'withWorktree').mockRejectedValueOnce(new Error('worktree add failed'));

    const { groomCommand } = await import('../../src/commands/groom.js');

    await expect(groomCommand(repo, '123')).rejects.toThrow('worktree add failed');

    expect(promptCalls).toEqual([]);
  });
});
