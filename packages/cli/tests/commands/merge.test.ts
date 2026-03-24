import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const tryResolvePrForIssueMock =
  vi.fn<(repo: string, issueNumber: number) => Promise<string | undefined>>();
const getSettingsMock = vi.fn<
  () => {
    prReviewWait: { mode: 'checks'; timeoutMinutes: number };
    merge: { requirePassingChecks: boolean };
  }
>();
const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();
interface MockCheck {
  name: string;
  state: string;
  bucket: string;
}

const fetchChecksMock = vi.fn<(repo: string, pr: string) => Promise<MockCheck[]>>();
const classifyChecksMock = vi.fn<
  (checks: MockCheck[]) => {
    pending: MockCheck[];
    failed: MockCheck[];
    passed: MockCheck[];
    total: number;
  }
>();
vi.mock('@dnsquared/shipper-core', () => ({
  getSettings: () => getSettingsMock(),
  gh: (args: string[]) => ghMock(args),
  tryResolvePrForIssue: (repo: string, issueNumber: number) =>
    tryResolvePrForIssueMock(repo, issueNumber),
  getRepoNwo: () => 'owner/repo',
  withStageHooks: vi.fn((_stage: unknown, _env: unknown, fn: () => Promise<unknown>) => fn()),
  fetchChecks: (repo: string, pr: string) => fetchChecksMock(repo, pr),
  classifyChecks: (checks: MockCheck[]) => classifyChecksMock(checks),
}));

const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
const errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  ghMock.mockReset();
  getSettingsMock.mockReset();
  tryResolvePrForIssueMock.mockReset();
  fetchChecksMock.mockReset();
  classifyChecksMock.mockReset();
  logMock.mockClear();
  warnMock.mockClear();
  errorMock.mockClear();
  getSettingsMock.mockReturnValue({
    prReviewWait: { mode: 'checks', timeoutMinutes: 30 },
    merge: { requirePassingChecks: true },
  });
});

const { getLinkedIssueNumber, postMerge, lookupPR, mergeCommand } =
  await import('../../src/commands/merge.js');

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

describe('requirePassingChecks', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  function mockPRLookup(
    mergeStateStatus: string,
    options?: {
      mergeError?: Error;
      verificationState?: string;
      verificationError?: Error;
      verificationStdout?: string;
    }
  ) {
    const {
      mergeError,
      verificationState = 'OPEN',
      verificationError,
      verificationStdout,
    } = options ?? {};

    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        const jsonFields = args[args.indexOf('--json') + 1] ?? '';
        if (jsonFields === 'mergeStateStatus') {
          return Promise.resolve({ stdout: JSON.stringify({ mergeStateStatus }), stderr: '' });
        }
        if (jsonFields === 'state') {
          if (verificationError) {
            return Promise.reject(verificationError);
          }
          return Promise.resolve({
            stdout: verificationStdout ?? JSON.stringify({ state: verificationState }),
            stderr: '',
          });
        }
        if (jsonFields === 'number,title,headRefName,baseRefName,state,labels') {
          return Promise.resolve({
            stdout: JSON.stringify({
              number: 42,
              title: 'Test PR',
              headRefName: 'feat',
              baseRefName: 'main',
              state: 'OPEN',
              labels: [{ name: 'shipper:ready' }],
            }),
            stderr: '',
          });
        }
        if (jsonFields.includes('body')) {
          return Promise.resolve({ stdout: JSON.stringify({ body: 'Closes #10' }), stderr: '' });
        }
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        if (mergeError) {
          return Promise.reject(mergeError);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (args[0] === 'issue') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
  }

  it('merges when all checks pass and requirePassingChecks is true', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }]);
    classifyChecksMock.mockReturnValue({
      pending: [],
      failed: [],
      passed: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }],
      total: 1,
    });

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(ghMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'pr',
        'merge',
        '42',
        '-R',
        'owner/repo',
        '--rebase',
        '--delete-branch',
      ])
    );
  });

  it('fails PR when checks are failing and requirePassingChecks is true', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'FAILURE', bucket: 'fail' }]);
    classifyChecksMock.mockReturnValue({
      pending: [],
      failed: [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }],
      passed: [],
      total: 1,
    });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('CI checks failed: ci'));
  });

  it('retries when checks are pending and requirePassingChecks is true', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockResolvedValue([{ name: 'ci', state: 'PENDING', bucket: 'pending' }]);
    classifyChecksMock.mockReturnValue({
      pending: [{ name: 'ci', state: 'PENDING', bucket: 'pending' }],
      failed: [],
      passed: [],
      total: 1,
    });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining('Checks still running: ci. Will retry next cycle.')
    );
  });

  it('merges when no checks exist and requirePassingChecks is true', async () => {
    mockPRLookup('CLEAN');
    fetchChecksMock.mockResolvedValue([]);
    classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(ghMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'pr',
        'merge',
        '42',
        '-R',
        'owner/repo',
        '--rebase',
        '--delete-branch',
      ])
    );
  });

  it('skips check verification when requirePassingChecks is false', async () => {
    getSettingsMock.mockReturnValue({
      prReviewWait: { mode: 'checks', timeoutMinutes: 30 },
      merge: { requirePassingChecks: false },
    });
    mockPRLookup('CLEAN');

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(fetchChecksMock).not.toHaveBeenCalled();
    expect(ghMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'pr',
        'merge',
        '42',
        '-R',
        'owner/repo',
        '--rebase',
        '--delete-branch',
      ])
    );
  });

  it('runs post-merge cleanup when merge reports an error but verification confirms MERGED', async () => {
    mockPRLookup('CLEAN', {
      mergeError: new Error('merge request timed out'),
      verificationState: 'MERGED',
    });
    fetchChecksMock.mockResolvedValue([]);
    classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });

    await mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' });

    expect(ghMock).toHaveBeenCalledWith([
      'pr',
      'view',
      '42',
      '-R',
      'owner/repo',
      '--json',
      'state',
    ]);
    expect(ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '10',
      '-R',
      'owner/repo',
      '--remove-label',
      'shipper:ready',
    ]);
    expect(ghMock).toHaveBeenCalledWith(['issue', 'close', '10', '-R', 'owner/repo']);
    expect(findCalls('pr', 'edit')).toHaveLength(0);
    expect(findCalls('pr', 'comment')).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith(
      '  PR #42 merge succeeded despite reported error. Proceeding with post-merge cleanup.'
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('remediates when merge reports an error and verification confirms the PR is still open', async () => {
    mockPRLookup('CLEAN', {
      mergeError: new Error('merge failed'),
      verificationState: 'OPEN',
    });
    fetchChecksMock.mockResolvedValue([]);
    classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(ghMock).toHaveBeenCalledWith([
      'pr',
      'view',
      '42',
      '-R',
      'owner/repo',
      '--json',
      'state',
    ]);
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
    expect(findCalls('issue', 'edit')).toHaveLength(0);
    expect(findCalls('issue', 'close')).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith('  PR #42 failed: Merge failed: merge failed');
  });

  it('remediates when merge verification fails after a reported merge error', async () => {
    mockPRLookup('CLEAN', {
      mergeError: new Error('merge failed'),
      verificationStdout: '{"status":"MERGED"}',
    });
    fetchChecksMock.mockResolvedValue([]);
    classifyChecksMock.mockReturnValue({ pending: [], failed: [], passed: [], total: 0 });

    await expect(
      mergeCommand({ interval: '30', once: true, dryRun: false, number: '42' })
    ).rejects.toThrow('exit:1');

    expect(ghMock).toHaveBeenCalledWith([
      'pr',
      'view',
      '42',
      '-R',
      'owner/repo',
      '--json',
      'state',
    ]);
    expect(findCalls('pr', 'edit')).toHaveLength(2);
    expect(findCalls('pr', 'comment')).toHaveLength(1);
    expect(findCalls('issue', 'edit')).toHaveLength(0);
    expect(findCalls('issue', 'close')).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith('  PR #42 failed: Merge failed: merge failed');
  });
});

function findCalls(command: string, subcommand: string): string[][] {
  return ghMock.mock.calls
    .map(([args]) => args)
    .filter((args) => args[0] === command && args[1] === subcommand);
}
