import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';

type FakeCore = ReturnType<typeof createFakeCore>;

const repo = 'owner/repo';

describe('unlockCommand', () => {
  let fake: FakeCore;
  let errorSpy: MockInstance;

  const stubLockedIssueList = (issues: number[]): void => {
    fake.stubGh((args) => {
      if (
        args[0] === 'issue' &&
        args[1] === 'list' &&
        args.includes('-R') &&
        args.includes('--json') &&
        args.includes('number,title,labels,state,author,createdAt,url') &&
        args.includes('--label') &&
        args.includes('shipper:locked')
      ) {
        return {
          stdout: JSON.stringify(
            issues.map((number) => ({
              number,
              title: `Issue ${number}`,
              labels: [{ name: 'shipper:locked' }],
              state: 'OPEN',
              author: { login: 'dnsquared' },
              createdAt: '2026-03-01T09:00:00Z',
              url: `https://example.test/issues/${number}`,
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
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake.dispose();
  });

  it('calls releaseIssueLock with the repo and issue number', async () => {
    fake.setIssue('42', { labels: ['shipper:locked'] });

    const { unlockCommand } = await import('../../src/commands/unlock.js');

    await unlockCommand(repo, '42', { stale: false });

    expect(fake.state.labelTransitions).toEqual([
      { target: 'issue', number: '42', add: [], remove: ['shipper:locked'] },
    ]);
    expect(fake.state.issues.get('42')?.labels).toEqual(new Set());
  });

  it('strips # prefixes from issue numbers', async () => {
    fake.setIssue('42', { labels: ['shipper:locked'] });

    const { unlockCommand } = await import('../../src/commands/unlock.js');

    await unlockCommand(repo, '#42', { stale: false });

    expect(fake.state.issues.get('42')?.labels).toEqual(new Set());
  });

  it('throws a usage error when no issue and no --stale are provided', async () => {
    const { unlockCommand } = await import('../../src/commands/unlock.js');

    await expect(unlockCommand(repo, undefined, { stale: false })).rejects.toThrow(
      'Error: Please provide an issue number or use --stale.'
    );
    expect(errorSpy).toHaveBeenNthCalledWith(1, '[shipper] Usage: shipper unlock <issue>');
    expect(errorSpy).toHaveBeenNthCalledWith(2, '[shipper]    or: shipper unlock --stale');
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('throws when an issue and --stale are both provided', async () => {
    const { unlockCommand } = await import('../../src/commands/unlock.js');

    await expect(unlockCommand(repo, '42', { stale: true })).rejects.toThrow(
      'Error: --stale cannot be used with an issue number.'
    );
    expect(errorSpy).toHaveBeenNthCalledWith(1, '[shipper] Usage: shipper unlock <issue>');
    expect(errorSpy).toHaveBeenNthCalledWith(2, '[shipper]    or: shipper unlock --stale');
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('prints no-op output when no locked issues are found for --stale', async () => {
    stubLockedIssueList([]);

    const { unlockCommand } = await import('../../src/commands/unlock.js');

    await expect(unlockCommand(repo, undefined, { stale: true })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith('[shipper] No stale locks found.');
    expect(fake.state.labelTransitions).toEqual([]);
  });

  it('releases only stale locks and prints per-issue status plus summary', async () => {
    const staleTimestamp = new Date(Date.now() - 31 * 60_000).toISOString();
    const activeTimestamp = new Date().toISOString();
    fake.setIssue('42', { labels: ['shipper:locked'], timeline: [staleTimestamp] });
    fake.setIssue('43', { labels: ['shipper:locked'], timeline: [activeTimestamp] });
    stubLockedIssueList([42, 43]);

    const { unlockCommand } = await import('../../src/commands/unlock.js');

    await expect(unlockCommand(repo, undefined, { stale: true })).resolves.toBeUndefined();

    expect(fake.state.labelTransitions).toEqual([
      { target: 'issue', number: '42', add: [], remove: ['shipper:locked'] },
    ]);
    expect(errorSpy).toHaveBeenNthCalledWith(1, '[shipper] #42: stale — released');
    expect(errorSpy).toHaveBeenNthCalledWith(2, '[shipper] #43: active — skipped');
    expect(errorSpy).toHaveBeenNthCalledWith(
      3,
      '[shipper] Released 1 stale lock(s) (1 active lock(s) skipped).'
    );
  });

  it('prints active lines and no stale summary when all locked issues are active', async () => {
    const activeTimestamp = new Date().toISOString();
    fake.setIssue('42', { labels: ['shipper:locked'], timeline: [activeTimestamp] });
    fake.setIssue('43', { labels: ['shipper:locked'], timeline: [activeTimestamp] });
    stubLockedIssueList([42, 43]);

    const { unlockCommand } = await import('../../src/commands/unlock.js');

    await expect(unlockCommand(repo, undefined, { stale: true })).resolves.toBeUndefined();

    expect(fake.state.labelTransitions).toEqual([]);
    expect(errorSpy).toHaveBeenNthCalledWith(1, '[shipper] #42: active — skipped');
    expect(errorSpy).toHaveBeenNthCalledWith(2, '[shipper] #43: active — skipped');
    expect(errorSpy).toHaveBeenNthCalledWith(3, '[shipper] No stale locks found.');
  });
});
