import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { RunPromptOpts } from '@baremetallabs-ai/shipper-core';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

const repo = 'owner/repo';

function buildFullIssueView(issueNumber: string, commentBodies: string[]): string {
  return JSON.stringify({
    number: Number(issueNumber),
    title: `Issue ${issueNumber}`,
    state: 'OPEN',
    labels: [{ name: 'shipper:blocked' }],
    body: '',
    comments: commentBodies.map((body, index) => ({
      author: { login: `commenter-${index + 1}` },
      body,
      createdAt: `2026-03-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
    })),
    author: { login: 'dnsquared' },
    createdAt: '2026-03-01T09:00:00Z',
  });
}

describe('prepareUnblockContext', () => {
  let fake: FakeCore;

  const stubFetchedIssue = (issueNumber: string, commentBodies: string[]): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === issueNumber &&
        args.includes('--json') &&
        args.includes('number,title,state,labels,body,comments,author,createdAt')
      ) {
        return {
          stdout: buildFullIssueView(issueNumber, commentBodies),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  const stubDependencyIssue = (ref: string, title: string, state: string): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === ref &&
        args.includes('--json') &&
        args.includes('state,title')
      ) {
        return {
          stdout: JSON.stringify({ title, state }),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  const stubDependencyPr = (
    ref: string,
    payload: { title: string; state: string; mergedAt: string | null } | Error
  ): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args[2] === ref &&
        args.includes('--json') &&
        args.includes('state,mergedAt,title')
      ) {
        if (payload instanceof Error) {
          throw payload;
        }

        return {
          stdout: JSON.stringify(payload),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  const readDependencies = async (): Promise<string> => {
    return await readFile(
      path.join(fake.wtPath(), '.shipper', 'input', 'dependencies.md'),
      'utf-8'
    );
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('writes dependency context for referenced issues and PRs while deduplicating refs', async () => {
    stubFetchedIssue('250', ['Blocked by #248, #248, and #249. Ignore #250.']);
    stubDependencyIssue('248', 'Core protocol infra', 'CLOSED');
    stubDependencyPr('248', new Error('not a pr'));
    stubDependencyIssue('249', 'Protocol PR', 'CLOSED');
    stubDependencyPr('249', {
      title: 'Protocol PR',
      state: 'MERGED',
      mergedAt: '2026-03-14T03:00:00Z',
    });

    const { prepareUnblockContext } = await import('../../src/commands/unblock.js');

    await prepareUnblockContext(repo, '250', fake.wtPath());

    const markdown = await readDependencies();
    expect(markdown).toContain('# Dependency Status');
    expect(markdown).toContain('## #248');
    expect(markdown).toContain('- **Type**: Issue');
    expect(markdown).toContain('- **Title**: Core protocol infra');
    expect(markdown).toContain('- **State**: CLOSED');
    expect(markdown).toContain('## #249');
    expect(markdown).toContain('- **Type**: PR');
    expect(markdown).toContain('- **State**: MERGED (merged 2026-03-14)');
    expect(markdown).not.toContain('## #250');
  });

  it('writes an empty dependency status file when no refs remain after filtering', async () => {
    stubFetchedIssue('250', ['No dependencies here.']);

    const { prepareUnblockContext } = await import('../../src/commands/unblock.js');

    await prepareUnblockContext(repo, '250', fake.wtPath());

    await expect(readDependencies()).resolves.toBe('# Dependency Status\n');
  });

  it('excludes self references when building dependency context', async () => {
    stubFetchedIssue('250', ['Blocked by #250 and #251.']);
    stubDependencyIssue('251', 'Follow-up issue', 'OPEN');
    stubDependencyPr('251', new Error('not a pr'));

    const { prepareUnblockContext } = await import('../../src/commands/unblock.js');

    await prepareUnblockContext(repo, '250', fake.wtPath());

    const markdown = await readDependencies();
    expect(markdown).toContain('## #251');
    expect(markdown).not.toContain('## #250');
  });

  it('records unknown dependency refs instead of aborting when an issue lookup fails', async () => {
    stubFetchedIssue('250', ['Blocked by #248 and #9999.']);
    stubDependencyIssue('248', 'Core protocol infra', 'CLOSED');
    stubDependencyPr('248', new Error('not a pr'));
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === '9999' &&
        args.includes('--json') &&
        args.includes('state,title')
      ) {
        throw new Error('issue not found');
      }
      return undefined;
    });

    const { prepareUnblockContext } = await import('../../src/commands/unblock.js');

    await prepareUnblockContext(repo, '250', fake.wtPath());

    const markdown = await readDependencies();
    expect(markdown).toContain('## #248');
    expect(markdown).toContain('## #9999');
    expect(markdown).toContain('- **Type**: Unknown');
    expect(markdown).toContain('- **Detail**: issue not found');
  });
});

describe('unblockCommand', () => {
  let fake: FakeCore;
  let cwdSpy: MockInstance;
  let promptCalls: Array<{ name: string; opts: RunPromptOpts }>;

  const stubFetchedIssue = (issueNumber: string, commentBodies: string[]): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === issueNumber &&
        args.includes('--json') &&
        args.includes('number,title,state,labels,body,comments,author,createdAt')
      ) {
        return {
          stdout: buildFullIssueView(issueNumber, commentBodies),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  const stubDependencyIssue = (ref: string, title: string, state: string): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === ref &&
        args.includes('--json') &&
        args.includes('state,title')
      ) {
        return {
          stdout: JSON.stringify({ title, state }),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  const stubDependencyPrNotFound = (ref: string): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args[2] === ref &&
        args.includes('--json') &&
        args.includes('state,mergedAt,title')
      ) {
        throw new Error('not a pr');
      }
      return undefined;
    });
  };

  const readDependencies = async (): Promise<string> => {
    return await readFile(
      path.join(fake.wtPath(), '.shipper', 'input', 'dependencies.md'),
      'utf-8'
    );
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    promptCalls = [];
    process.exitCode = undefined;
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fake.wtPath());
  });

  afterEach(async () => {
    process.exitCode = undefined;
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('scrubs output, prepares dependency context, and processes protocol results', async () => {
    fake.setIssue('250', { labels: ['shipper:blocked'], title: 'Blocked issue' });
    stubFetchedIssue('250', ['Blocked by #248.']);
    stubDependencyIssue('248', 'Core protocol infra', 'CLOSED');
    stubDependencyPrNotFound('248');
    fake.scriptRunPrompt(async (name, opts) => {
      promptCalls.push({ name, opts });
      await fake.writeStageOutput({
        result: { verdict: 'accept', comment: '.shipper/output/comment-250.md' },
        commentBody: 'Unblocked.',
      });
      return 0;
    });

    const { unblockCommand } = await import('../../src/commands/unblock.js');

    await expect(unblockCommand(repo, '250')).resolves.toBeUndefined();

    await expect(readDependencies()).resolves.toContain('## #248');
    expect(promptCalls).toEqual([
      {
        name: 'unblock',
        opts: {
          repo,
          issueRef: '250',
          cwd: fake.wtPath(),
          mode: undefined,
          agent: undefined,
          model: undefined,
          disableMcp: undefined,
        },
      },
    ]);
    expect(fake.state.postedComments).toEqual([
      { target: 'issue', number: '250', body: 'Unblocked.' },
    ]);
    expect(fake.state.labelTransitions).toEqual([
      { target: 'issue', number: '250', add: ['shipper:locked'], remove: [] },
      { target: 'issue', number: '250', add: [], remove: ['shipper:blocked'] },
      { target: 'issue', number: '250', add: [], remove: ['shipper:locked'] },
    ]);
    expect(fake.state.issues.get('250')?.labels).toEqual(new Set());
    expect(process.exitCode).toBeUndefined();
  });

  it('reports non-zero prompt exits and skips result processing', async () => {
    fake.setIssue('250', { labels: ['shipper:blocked'], title: 'Blocked issue' });
    stubFetchedIssue('250', ['Blocked by #248.']);
    stubDependencyIssue('248', 'Core protocol infra', 'CLOSED');
    stubDependencyPrNotFound('248');
    fake.scriptRunPrompt((name, opts) => {
      promptCalls.push({ name, opts });
      return 13;
    });

    const { unblockCommand } = await import('../../src/commands/unblock.js');

    await expect(unblockCommand(repo, '250')).resolves.toBeUndefined();

    expect(promptCalls).toHaveLength(1);
    expect(fake.state.postedComments.at(-1)?.body).toContain('The `unblock` agent run exited');
    expect(fake.state.issues.get('250')?.labels).toEqual(new Set(['shipper:blocked']));
    expect(process.exitCode).toBe(1);
  });

  it('reports invalid output after the retry flow and exits with code 1', async () => {
    fake.setIssue('250', { labels: ['shipper:blocked'], title: 'Blocked issue' });
    stubFetchedIssue('250', ['Blocked by #248.']);
    stubDependencyIssue('248', 'Core protocol infra', 'CLOSED');
    stubDependencyPrNotFound('248');
    fake.scriptRunPrompt((name, opts) => {
      promptCalls.push({ name, opts });
      return 0;
    });

    const { unblockCommand } = await import('../../src/commands/unblock.js');

    await expect(unblockCommand(repo, '250')).resolves.toBeUndefined();

    expect(promptCalls).toHaveLength(3);
    expect(promptCalls[1]?.opts.userInput).toContain('Missing result.json');
    expect(promptCalls[2]?.opts.userInput).toContain('Missing result.json');
    expect(fake.state.postedComments.at(-1)?.body).toContain('Missing result.json');
    expect(fake.state.issues.get('250')?.labels).toEqual(new Set(['shipper:blocked']));
    expect(process.exitCode).toBe(1);
  });

  it('forwards disableMcp on both initial and retry unblock runs', async () => {
    fake.setIssue('250', { labels: ['shipper:blocked'], title: 'Blocked issue' });
    stubFetchedIssue('250', ['Blocked by #248.']);
    stubDependencyIssue('248', 'Core protocol infra', 'CLOSED');
    stubDependencyPrNotFound('248');
    fake.scriptRunPrompt((name, opts) => {
      promptCalls.push({ name, opts });
      return 0;
    });

    const { unblockCommand } = await import('../../src/commands/unblock.js');

    await expect(
      unblockCommand(repo, '250', undefined, undefined, undefined, true)
    ).resolves.toBeUndefined();

    expect(promptCalls.every((call) => call.opts.disableMcp === true)).toBe(true);
  });
});
