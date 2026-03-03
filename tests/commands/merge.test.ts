import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.fn();
const execSyncMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

const getSettingsMock = vi.fn();
vi.mock('../../src/lib/settings.js', () => ({
  getSettings: () => getSettingsMock(),
}));

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  execFileSyncMock.mockReset();
  execSyncMock.mockReset();
  getSettingsMock.mockReset();
  logMock.mockClear();
  warnMock.mockClear();
  getSettingsMock.mockReturnValue({ prReviewWaitMinutes: 30, hooks: {} });
});

const { getLinkedIssueNumber, postMerge } = await import('../../src/commands/merge.js');

const mockPR = {
  number: 42,
  title: 'Test PR',
  headRefName: '25-add-feature',
  baseRefName: 'main',
  labeledAt: '2026-01-01T00:00:00Z',
};

describe('getLinkedIssueNumber', () => {
  it('returns issue number when PR body contains Closes #N', () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({ body: 'Some text\n\nCloses #25\n' }));
    expect(getLinkedIssueNumber(42, 'owner/repo')).toBe(25);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '42', '-R', 'owner/repo', '--json', 'body'],
      expect.objectContaining({ encoding: 'utf-8' })
    );
  });

  it('returns issue number for Fixes #N', () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({ body: 'Fixes #10' }));
    expect(getLinkedIssueNumber(1, 'o/r')).toBe(10);
  });

  it('returns issue number for Resolves #N', () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({ body: 'Resolves #99' }));
    expect(getLinkedIssueNumber(1, 'o/r')).toBe(99);
  });

  it('returns null when PR body has no closing keyword', () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({ body: 'Just a regular PR body' }));
    expect(getLinkedIssueNumber(42, 'owner/repo')).toBeNull();
  });

  it('returns null when gh pr view throws', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('gh failed');
    });
    expect(getLinkedIssueNumber(42, 'owner/repo')).toBeNull();
  });
});

describe('postMerge', () => {
  it('executes hook with correct env vars when configured', () => {
    getSettingsMock.mockReturnValue({
      prReviewWaitMinutes: 30,
      hooks: { postMerge: 'echo done' },
    });
    execFileSyncMock.mockReturnValue('');

    postMerge(mockPR, 25, 'owner/repo', false);

    expect(execSyncMock).toHaveBeenCalledWith('echo done', {
      stdio: 'inherit',
      env: expect.objectContaining({
        SHIPPER_PR_NUMBER: '42',
        SHIPPER_ISSUE_NUMBER: '25',
        SHIPPER_BRANCH_NAME: '25-add-feature',
      }),
    });
    expect(logMock).toHaveBeenCalledWith('  Post-merge hook completed.');
  });

  it('logs warning when hook exits non-zero and continues', () => {
    getSettingsMock.mockReturnValue({
      prReviewWaitMinutes: 30,
      hooks: { postMerge: 'exit 1' },
    });
    const err = new Error('Command failed') as Error & { status: number; stderr: Buffer };
    err.status = 1;
    err.stderr = Buffer.from('something went wrong');
    execSyncMock.mockImplementation(() => {
      throw err;
    });
    // execFileSync for label cleanup and issue close
    execFileSyncMock.mockReturnValue('');

    postMerge(mockPR, 25, 'owner/repo', false);

    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Post-merge hook exited with code 1')
    );
    // Label cleanup and issue close should still be called
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '25', '-R', 'owner/repo', '--remove-label', 'shipper:ready'],
      expect.anything()
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'close', '25', '-R', 'owner/repo'],
      expect.anything()
    );
  });

  it('skips hook when not configured and still cleans up', () => {
    getSettingsMock.mockReturnValue({ prReviewWaitMinutes: 30, hooks: {} });
    execFileSyncMock.mockReturnValue('');

    postMerge(mockPR, 25, 'owner/repo', false);

    expect(execSyncMock).not.toHaveBeenCalled();
    // Label cleanup should still run
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '25', '-R', 'owner/repo', '--remove-label', 'shipper:ready'],
      expect.anything()
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'close', '25', '-R', 'owner/repo'],
      expect.anything()
    );
  });

  it('logs dry-run messages with hook configured', () => {
    getSettingsMock.mockReturnValue({
      prReviewWaitMinutes: 30,
      hooks: { postMerge: 'echo done' },
    });

    postMerge(mockPR, 25, 'owner/repo', true);

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith('  [dry-run] Would execute post-merge hook: echo done');
    expect(logMock).toHaveBeenCalledWith(
      '    SHIPPER_PR_NUMBER=42 SHIPPER_ISSUE_NUMBER=25 SHIPPER_BRANCH_NAME=25-add-feature'
    );
    expect(logMock).toHaveBeenCalledWith(
      '  [dry-run] Would remove shipper:ready and close issue #25'
    );
  });

  it('logs dry-run label message without hook configured', () => {
    getSettingsMock.mockReturnValue({ prReviewWaitMinutes: 30, hooks: {} });

    postMerge(mockPR, 25, 'owner/repo', true);

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      '  [dry-run] Would remove shipper:ready and close issue #25'
    );
  });
});
