import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

describe('adoptCommand', () => {
  let fake: FakeCore;
  let logSpy: MockInstance;
  let errorSpy: MockInstance;
  let warnSpy: MockInstance;

  const stubIssueView = (issueNumber: string, labels: string[]): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'view' &&
        args[2] === issueNumber &&
        args.includes('--json') &&
        args.includes('number,labels')
      ) {
        return {
          stdout: JSON.stringify({
            number: Number(issueNumber),
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

  const stubIssueList = (issues: Array<{ number: number; labels: string[] }>): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'list' &&
        args.includes('--json') &&
        args.includes('number,labels')
      ) {
        return {
          stdout: JSON.stringify(
            issues.map((issue) => ({
              number: issue.number,
              labels: issue.labels.map((name) => ({ name })),
            }))
          ),
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
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('adopts a valid issue with no shipper labels', async () => {
    fake.setIssue('42', { labels: [] });
    stubIssueView('42', []);
    stubPrCheck('42', false);

    const { adoptCommand } = await import('../../src/commands/adopt.js');

    await adoptCommand('42');

    expect(fake.state.labelTransitions).toEqual([
      { target: 'issue', number: '42', add: ['shipper:new'], remove: [] },
    ]);
    expect(logSpy).toHaveBeenCalledWith('[shipper] Issue #42 adopted into shipper workflow.');
  });

  it('warns and does not modify an issue that already has shipper labels', async () => {
    fake.setIssue('42', { labels: ['shipper:groomed'] });
    stubIssueView('42', ['shipper:groomed']);
    stubPrCheck('42', false);

    const { adoptCommand } = await import('../../src/commands/adopt.js');

    await adoptCommand('42');

    expect(warnSpy).toHaveBeenCalledWith(
      '[shipper] Warning: Issue #42 already has shipper label(s): shipper:groomed. No changes made.'
    );
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('throws for non-existent issues', async () => {
    fake.stubGh((args) => {
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '9999') {
        throw new Error('not found');
      }
      return undefined;
    });

    const { adoptCommand } = await import('../../src/commands/adopt.js');

    await expect(adoptCommand('9999')).rejects.toThrow('Error: Issue #9999 not found.');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('throws when the reference is a pull request', async () => {
    fake.setIssue('42', { labels: [] });
    stubIssueView('42', []);
    stubPrCheck('42', true);

    const { adoptCommand } = await import('../../src/commands/adopt.js');

    await expect(adoptCommand('42')).rejects.toThrow('Error: #42 is a pull request, not an issue.');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('strips # prefixes from the issue reference', async () => {
    fake.setIssue('42', { labels: [] });
    stubIssueView('42', []);
    stubPrCheck('42', false);

    const { adoptCommand } = await import('../../src/commands/adopt.js');

    await adoptCommand('#42');

    expect(fake.state.issues.get('42')?.labels).toEqual(new Set(['shipper:new']));
  });

  it('throws for non-numeric input and still prints usage', async () => {
    const { adoptCommand } = await import('../../src/commands/adopt.js');

    await expect(adoptCommand('abc')).rejects.toThrow(
      'Error: Please provide a valid issue number.'
    );
    expect(errorSpy).toHaveBeenCalledWith('[shipper] Usage: shipper adopt <issue>');
  });

  it('adopts multiple eligible issues and skips labeled ones', async () => {
    fake.setIssue('10', { labels: [] });
    fake.setIssue('11', { labels: ['shipper:groomed'] });
    fake.setIssue('12', { labels: [] });
    fake.setIssue('13', { labels: ['bug'] });
    stubIssueList([
      { number: 10, labels: [] },
      { number: 11, labels: ['shipper:groomed'] },
      { number: 12, labels: [] },
      { number: 13, labels: ['bug'] },
    ]);

    const { adoptAllCommand } = await import('../../src/commands/adopt.js');

    await adoptAllCommand();

    expect(fake.state.labelTransitions).toEqual([
      { target: 'issue', number: '10', add: ['shipper:new'], remove: [] },
      { target: 'issue', number: '12', add: ['shipper:new'], remove: [] },
      { target: 'issue', number: '13', add: ['shipper:new'], remove: [] },
    ]);
    expect(logSpy).toHaveBeenCalledWith('[shipper] Adopted #10, #12, #13 into shipper workflow.');
  });

  it('prints a message when no eligible issues are found', async () => {
    stubIssueList([{ number: 5, labels: ['shipper:new'] }]);

    const { adoptAllCommand } = await import('../../src/commands/adopt.js');

    await adoptAllCommand();

    expect(logSpy).toHaveBeenCalledWith('[shipper] No eligible issues found.');
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('throws when gh issue list fails', async () => {
    fake.stubGh((args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        throw new Error('gh issue list failed');
      }
      return undefined;
    });

    const { adoptAllCommand } = await import('../../src/commands/adopt.js');

    await expect(adoptAllCommand()).rejects.toThrow('Error: Failed to fetch issues.');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('continues labeling remaining issues when one fails and sets process.exitCode', async () => {
    fake.setIssue('10', { labels: [] });
    fake.setIssue('12', { labels: [] });
    fake.setIssue('13', { labels: [] });
    stubIssueList([
      { number: 10, labels: [] },
      { number: 12, labels: [] },
      { number: 13, labels: [] },
    ]);
    fake.stubGh((args) => {
      if (args[0] === 'issue' && args[1] === 'edit' && args[2] === '12') {
        throw new Error('API error');
      }
      return undefined;
    });

    const { adoptAllCommand } = await import('../../src/commands/adopt.js');

    await expect(adoptAllCommand()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[shipper] Error: Failed to add 'shipper:new' label to issue #12."
    );
    expect(logSpy).toHaveBeenCalledWith('[shipper] Adopted #10, #13 into shipper workflow.');
    expect(process.exitCode).toBe(1);
  });

  it('handles empty repositories with no issues', async () => {
    stubIssueList([]);

    const { adoptAllCommand } = await import('../../src/commands/adopt.js');

    await adoptAllCommand();

    expect(logSpy).toHaveBeenCalledWith('[shipper] No eligible issues found.');
    expect(fake.state.labelTransitions).toEqual([]);
  });
});
