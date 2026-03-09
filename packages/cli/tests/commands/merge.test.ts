import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const tryResolvePrForIssueMock = vi.fn();
const getSettingsMock = vi.fn();
const ghMock = vi.fn();
vi.mock('@dnsquared/shipper-core', () => ({
  getSettings: () => getSettingsMock(),
  gh: (...args: unknown[]) => ghMock(...args),
  tryResolvePrForIssue: (...args: unknown[]) => tryResolvePrForIssueMock(...args),
  getRepoNwo: () => 'owner/repo',
  withStageHooks: vi.fn(
    async (_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => await fn()
  ),
  fetchChecks: vi.fn(),
  classifyChecks: vi.fn(),
}));

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  ghMock.mockReset();
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
  it('returns issue number when PR body contains Closes #N', async () => {
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({ body: 'Some text\n\nCloses #25\n' }),
      stderr: '',
    });
    await expect(getLinkedIssueNumber(42, 'owner/repo')).resolves.toBe(25);
    expect(ghMock).toHaveBeenCalledWith(['pr', 'view', '42', '-R', 'owner/repo', '--json', 'body']);
  });

  it('returns issue number for Fixes #N', async () => {
    ghMock.mockResolvedValue({ stdout: JSON.stringify({ body: 'Fixes #10' }), stderr: '' });
    await expect(getLinkedIssueNumber(1, 'o/r')).resolves.toBe(10);
  });

  it('returns issue number for Resolves #N', async () => {
    ghMock.mockResolvedValue({ stdout: JSON.stringify({ body: 'Resolves #99' }), stderr: '' });
    await expect(getLinkedIssueNumber(1, 'o/r')).resolves.toBe(99);
  });

  it('returns null when PR body has no closing keyword', async () => {
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({ body: 'Just a regular PR body' }),
      stderr: '',
    });
    await expect(getLinkedIssueNumber(42, 'owner/repo')).resolves.toBeNull();
  });

  it('returns null when gh pr view throws', async () => {
    ghMock.mockRejectedValue(new Error('gh failed'));
    await expect(getLinkedIssueNumber(42, 'owner/repo')).resolves.toBeNull();
  });
});

describe('postMerge', () => {
  it('cleans up labels and closes issue', async () => {
    ghMock.mockResolvedValue({ stdout: '', stderr: '' });

    await postMerge(mockPR, 25, 'owner/repo', false);

    expect(ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '25',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:ready',
    ]);
    expect(ghMock).toHaveBeenCalledWith(['issue', 'close', '25', '-R', 'owner/repo']);
  });

  it('logs dry-run message', async () => {
    await postMerge(mockPR, 25, 'owner/repo', true);

    expect(ghMock).not.toHaveBeenCalled();
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

  it('returns QueuedPR for a valid PR with shipper:ready label', async () => {
    ghMock.mockResolvedValue({ stdout: validPRJson, stderr: '' });

    const result = await lookupPR('42', 'owner/repo');

    expect(result).toEqual({
      number: 42,
      title: 'Add feature',
      headRefName: 'feature-branch',
      baseRefName: 'main',
      labeledAt: '',
    });
    expect(ghMock).toHaveBeenCalledWith([
      'pr',
      'view',
      '42',
      '-R',
      'owner/repo',
      '--json',
      'number,title,headRefName,baseRefName,state,labels',
    ]);
  });

  it('exits with error when PR does not have shipper:ready label', async () => {
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        title: 'Add feature',
        headRefName: 'feature-branch',
        baseRefName: 'main',
        state: 'OPEN',
        labels: [{ name: 'bug' }],
      }),
      stderr: '',
    });

    await expect(lookupPR('42', 'owner/repo')).rejects.toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith('Error: PR #42 does not have the shipper:ready label.');
  });

  it('exits with error when PR is closed', async () => {
    ghMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 42,
        title: 'Add feature',
        headRefName: 'feature-branch',
        baseRefName: 'main',
        state: 'CLOSED',
        labels: [{ name: 'shipper:ready' }],
      }),
      stderr: '',
    });

    await expect(lookupPR('42', 'owner/repo')).rejects.toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith('Error: PR #42 is not open (state: CLOSED).');
  });

  it('resolves issue to linked PR when ref is not a PR', async () => {
    ghMock
      .mockRejectedValueOnce(new Error('not a PR'))
      .mockResolvedValueOnce({ stdout: validPRJson, stderr: '' });
    tryResolvePrForIssueMock.mockResolvedValue('42');

    const result = await lookupPR('10', 'owner/repo');

    expect(tryResolvePrForIssueMock).toHaveBeenCalledWith('owner/repo', 10);
    expect(result).toEqual({
      number: 42,
      title: 'Add feature',
      headRefName: 'feature-branch',
      baseRefName: 'main',
      labeledAt: '',
    });
  });

  it('exits with error when issue has no linked PR', async () => {
    ghMock.mockRejectedValue(new Error('not found'));
    tryResolvePrForIssueMock.mockResolvedValue(undefined);

    await expect(lookupPR('99', 'owner/repo')).rejects.toThrow('exit:1');
    expect(errorMock).toHaveBeenCalledWith('Error: #99 is not a PR and no linked PR was found.');
  });
});
