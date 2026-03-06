import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const tryResolvePrForIssueMock = vi.fn();
vi.mock('../../src/lib/github.js', () => ({
  tryResolvePrForIssue: (...args: unknown[]) => tryResolvePrForIssueMock(...args),
}));

vi.mock('../../src/lib/repo.js', () => ({
  getRepoNwo: () => 'owner/repo',
}));

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  execFileSyncMock.mockReset();
  execSyncMock.mockReset();
  getSettingsMock.mockReset();
  tryResolvePrForIssueMock.mockReset();
  logMock.mockClear();
  warnMock.mockClear();
  errorMock.mockClear();
  getSettingsMock.mockReturnValue({
    prReviewWait: { mode: 'checks', timeoutMinutes: 30 },
    hooks: {},
  });
});

const { getLinkedIssueNumber, postMerge, lookupPR } = await import('../../src/commands/merge.js');

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
  it('cleans up labels and closes issue', () => {
    execFileSyncMock.mockReturnValue('');

    postMerge(mockPR, 25, 'owner/repo', false);

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

  it('logs dry-run message', () => {
    postMerge(mockPR, 25, 'owner/repo', true);

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      '  [dry-run] Would remove shipper:ready and close issue #25'
    );
  });
});

describe('lookupPR', () => {
  const validPRJson = JSON.stringify({
    number: 42,
    title: 'Add feature',
    headRefName: 'feature-branch',
    baseRefName: 'main',
    state: 'OPEN',
    labels: [{ name: 'shipper:ready' }],
  });

  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('returns QueuedPR for a valid PR with shipper:ready label', () => {
    execFileSyncMock.mockReturnValue(validPRJson);

    const result = lookupPR('42', 'owner/repo');

    expect(result).toEqual({
      number: 42,
      title: 'Add feature',
      headRefName: 'feature-branch',
      baseRefName: 'main',
      labeledAt: '',
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'view',
        '42',
        '-R',
        'owner/repo',
        '--json',
        'number,title,headRefName,baseRefName,state,labels',
      ],
      expect.objectContaining({ encoding: 'utf-8' })
    );
  });

  it('exits with error when PR does not have shipper:ready label', () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        number: 42,
        title: 'Add feature',
        headRefName: 'feature-branch',
        baseRefName: 'main',
        state: 'OPEN',
        labels: [{ name: 'bug' }],
      })
    );

    expect(() => lookupPR('42', 'owner/repo')).toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith('Error: PR #42 does not have the shipper:ready label.');
  });

  it('exits with error when PR is closed', () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        number: 42,
        title: 'Add feature',
        headRefName: 'feature-branch',
        baseRefName: 'main',
        state: 'CLOSED',
        labels: [{ name: 'shipper:ready' }],
      })
    );

    expect(() => lookupPR('42', 'owner/repo')).toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith('Error: PR #42 is not open (state: CLOSED).');
  });

  it('resolves issue to linked PR when ref is not a PR', () => {
    execFileSyncMock
      .mockImplementationOnce(() => {
        throw new Error('not a PR');
      })
      .mockReturnValueOnce(validPRJson);
    tryResolvePrForIssueMock.mockReturnValue('42');

    const result = lookupPR('10', 'owner/repo');

    expect(tryResolvePrForIssueMock).toHaveBeenCalledWith(10);
    expect(result).toEqual({
      number: 42,
      title: 'Add feature',
      headRefName: 'feature-branch',
      baseRefName: 'main',
      labeledAt: '',
    });
  });

  it('exits with error when issue has no linked PR', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    tryResolvePrForIssueMock.mockReturnValue(undefined);

    expect(() => lookupPR('99', 'owner/repo')).toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith('Error: #99 is not a PR and no linked PR was found.');
  });
});
