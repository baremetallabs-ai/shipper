import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

const repo = 'owner/repo';

describe('priorityCommand', () => {
  let fake: FakeCore;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const stubIssueView = (issueNumber: string, labels: string[], state = 'OPEN'): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === issueNumber &&
        args.includes('--json') &&
        args.includes('number,state,labels')
      ) {
        return {
          stdout: JSON.stringify({
            number: Number(issueNumber),
            state,
            labels: labels.map((name) => ({ name })),
          }),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  const stubPrCheck = (issueNumber: string, isPr: boolean): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args[2] === issueNumber &&
        args.includes('--json') &&
        args.includes('number,url')
      ) {
        if (!isPr) {
          throw new Error('not a PR');
        }

        return {
          stdout: JSON.stringify({
            number: Number(issueNumber),
            url: `https://example.test/${issueNumber}`,
          }),
          stderr: '',
        };
      }
      return undefined;
    });
  };

  beforeEach(() => {
    fake = createFakeCore();
    fake.install();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('sets high priority and removes low priority', async () => {
    fake.setIssue('42', { labels: ['shipper:planned', 'shipper:priority-low'] });
    stubIssueView('42', ['shipper:planned', 'shipper:priority-low']);
    stubPrCheck('42', false);

    const { priorityCommand } = await import('../../src/commands/priority.js');

    await priorityCommand(repo, '42', 'high');

    expect(fake.state.labelTransitions).toEqual([
      {
        target: 'issue',
        number: '42',
        add: ['shipper:priority-high'],
        remove: ['shipper:priority-low'],
      },
    ]);
    expect(logSpy).toHaveBeenCalledWith('[shipper] Issue #42 priority set to high.');
  });

  it('sets low priority and removes high priority', async () => {
    fake.setIssue('42', { labels: ['shipper:planned', 'shipper:priority-high'] });
    stubIssueView('42', ['shipper:planned', 'shipper:priority-high']);
    stubPrCheck('42', false);

    const { priorityCommand } = await import('../../src/commands/priority.js');

    await priorityCommand(repo, '42', 'low');

    expect(fake.state.labelTransitions).toEqual([
      {
        target: 'issue',
        number: '42',
        add: ['shipper:priority-low'],
        remove: ['shipper:priority-high'],
      },
    ]);
    expect(logSpy).toHaveBeenCalledWith('[shipper] Issue #42 priority set to low.');
  });

  it('removes both priority labels when setting normal priority', async () => {
    fake.setIssue('42', { labels: ['shipper:planned', 'shipper:priority-high'] });
    stubIssueView('42', ['shipper:planned', 'shipper:priority-high']);
    stubPrCheck('42', false);

    const { priorityCommand } = await import('../../src/commands/priority.js');

    await priorityCommand(repo, '42', 'normal');

    expect(fake.state.labelTransitions).toEqual([
      {
        target: 'issue',
        number: '42',
        add: [],
        remove: ['shipper:priority-high', 'shipper:priority-low'],
      },
    ]);
    expect(logSpy).toHaveBeenCalledWith('[shipper] Issue #42 priority set to normal.');
  });

  it('prints a no-op message when the issue is already normal priority', async () => {
    fake.setIssue('42', { labels: ['shipper:planned'] });
    stubIssueView('42', ['shipper:planned']);
    stubPrCheck('42', false);

    const { priorityCommand } = await import('../../src/commands/priority.js');

    await priorityCommand(repo, '42', 'normal');

    expect(logSpy).toHaveBeenCalledWith('[shipper] Issue #42 is already at normal priority.');
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('strips a leading # from the issue reference', async () => {
    fake.setIssue('42', { labels: ['shipper:planned'] });
    stubIssueView('42', ['shipper:planned']);
    stubPrCheck('42', false);

    const { priorityCommand } = await import('../../src/commands/priority.js');

    await priorityCommand(repo, '#42', 'high');

    expect(fake.state.issues.get('42')?.labels).toEqual(
      new Set(['shipper:planned', 'shipper:priority-high'])
    );
  });

  it('rejects pull requests', async () => {
    fake.setIssue('42', { labels: ['shipper:planned'] });
    stubIssueView('42', ['shipper:planned']);
    stubPrCheck('42', true);

    const { priorityCommand } = await import('../../src/commands/priority.js');

    await expect(priorityCommand(repo, '42', 'high')).rejects.toThrow(
      'Error: #42 is a pull request, not an issue.'
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects closed issues', async () => {
    stubIssueView('42', ['shipper:planned'], 'CLOSED');
    stubPrCheck('42', false);

    const { priorityCommand } = await import('../../src/commands/priority.js');

    await expect(priorityCommand(repo, '42', 'high')).rejects.toThrow(
      'Error: Issue #42 is not open.'
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects open issues that are not in the shipper workflow', async () => {
    stubIssueView('42', ['bug']);
    stubPrCheck('42', false);

    const { priorityCommand } = await import('../../src/commands/priority.js');

    await expect(priorityCommand(repo, '42', 'high')).rejects.toThrow(
      'Error: Issue #42 is not in the shipper workflow.'
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid issue numbers', async () => {
    const { priorityCommand } = await import('../../src/commands/priority.js');

    await expect(priorityCommand(repo, 'abc', 'high')).rejects.toThrow(
      'Error: Please provide a valid issue number.'
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[shipper] Usage: shipper priority <issue> <high|normal|low>'
    );
  });
});
