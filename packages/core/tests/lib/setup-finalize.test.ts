import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckClassification, PRChecksLine } from '../../src/index.js';
import type { GitStatusSnapshot } from '../../src/lib/setup-finalize.js';

const {
  execAsyncMock,
  readFileMock,
  mockFetchChecks,
  mockClassifyChecks,
  mockEnrichFailedChecks,
  mockGh,
  mockResolveBaseBranch,
  mockRunPrompt,
  mockGetRepoRoot,
  mockGetRepoNwo,
  mockGetSettings,
  mockSleepMs,
} = vi.hoisted(() => ({
  execAsyncMock:
    vi.fn<
      (
        command: string,
        args: string[],
        opts?: { cwd?: string }
      ) => Promise<{ stdout: string; stderr: string; code: number }>
    >(),
  readFileMock: vi.fn<(path: string) => Promise<Buffer>>(),
  mockFetchChecks: vi.fn<(repo: string, prRef: string) => Promise<PRChecksLine[]>>(),
  mockClassifyChecks: vi.fn<(checks: PRChecksLine[]) => CheckClassification>(),
  mockEnrichFailedChecks:
    vi.fn<(repo: string, failedChecks: PRChecksLine[]) => Promise<Map<string, string>>>(),
  mockGh:
    vi.fn<
      (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>
    >(),
  mockResolveBaseBranch: vi.fn<(repo: string, configured?: string) => Promise<string>>(),
  mockRunPrompt: vi.fn<(name: string, opts: Record<string, unknown>) => Promise<number>>(),
  mockGetRepoRoot: vi.fn<() => Promise<string>>(),
  mockGetRepoNwo: vi.fn<() => Promise<string>>(),
  mockGetSettings: vi.fn<() => { defaultBaseBranch?: string }>(),
  mockSleepMs: vi.fn<(ms: number) => Promise<void>>(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: (filePath: string) => readFileMock(filePath),
  };
});

vi.mock('../../src/lib/worktree/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/worktree/helpers.js')>(
    '../../src/lib/worktree/helpers.js'
  );
  return {
    ...actual,
    execAsync: (...args: Parameters<typeof execAsyncMock>) => execAsyncMock(...args),
  };
});

vi.mock('../../src/lib/checks.js', () => ({
  fetchChecks: (...args: Parameters<typeof mockFetchChecks>) => mockFetchChecks(...args),
  classifyChecks: (...args: Parameters<typeof mockClassifyChecks>) => mockClassifyChecks(...args),
  enrichFailedChecks: (...args: Parameters<typeof mockEnrichFailedChecks>) =>
    mockEnrichFailedChecks(...args),
}));

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: Parameters<typeof mockGh>) => mockGh(...args),
}));

vi.mock('../../src/lib/github.js', () => ({
  resolveBaseBranch: (...args: Parameters<typeof mockResolveBaseBranch>) =>
    mockResolveBaseBranch(...args),
}));

vi.mock('../../src/lib/prompt-runner.js', () => ({
  runPrompt: (...args: Parameters<typeof mockRunPrompt>) => mockRunPrompt(...args),
}));

vi.mock('../../src/lib/branch.js', () => ({
  getRepoRoot: () => mockGetRepoRoot(),
}));

vi.mock('../../src/lib/repo.js', () => ({
  getRepoNwo: () => mockGetRepoNwo(),
}));

vi.mock('../../src/lib/settings.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/settings.js')>(
    '../../src/lib/settings.js'
  );
  return {
    ...actual,
    getSettings: () => mockGetSettings(),
  };
});

vi.mock('../../src/lib/sleep.js', () => ({
  sleepMs: (ms: number) => mockSleepMs(ms),
}));

const { offerSetupFinalize, readGitStatusSnapshot } =
  await import('../../src/lib/setup-finalize.js');

function makeSnapshot(
  entries: Array<{
    path: string;
    indexStatus?: string;
    worktreeStatus?: string;
    contentSignature?: string;
  }>
): GitStatusSnapshot {
  const normalized = entries.map((entry) => ({
    path: entry.path,
    indexStatus: entry.indexStatus ?? '?',
    worktreeStatus: entry.worktreeStatus ?? '?',
  }));
  return {
    repoRoot: '/repo',
    entries: normalized,
    byPath: new Map(normalized.map((entry) => [entry.path, entry])),
    contentSignatureByPath: new Map(
      entries
        .filter(
          (
            entry
          ): entry is typeof entry & {
            contentSignature: string;
          } => entry.contentSignature !== undefined
        )
        .map((entry) => [entry.path, entry.contentSignature])
    ),
  };
}

function hashSignature(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function makeCheck(
  name: string,
  bucket: 'pass' | 'fail' | 'pending' | 'cancel',
  extras: Partial<PRChecksLine> = {}
): PRChecksLine {
  return {
    name,
    state: bucket === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
    bucket,
    ...extras,
  };
}

function mockGitStatusFlow(statuses: string[], options?: { currentBranch?: string }): void {
  const statusQueue = [...statuses];
  const currentBranch = options?.currentBranch ?? 'main';

  execAsyncMock.mockImplementation((_command, args, opts) => {
    const joined = args.join(' ');
    if (joined === 'rev-parse --show-toplevel') {
      return Promise.resolve({ stdout: '/repo\n', stderr: '', code: 0 });
    }
    if (joined === 'status --porcelain=v1 -z --untracked-files=all') {
      const stdout = statusQueue.shift();
      if (stdout === undefined) {
        throw new Error('Unexpected git status call');
      }
      return Promise.resolve({ stdout, stderr: '', code: 0 });
    }
    if (joined === 'rev-parse --verify chore/shipper-setup') {
      return Promise.resolve({ stdout: '', stderr: '', code: 1 });
    }
    if (joined === 'ls-remote --exit-code --heads origin chore/shipper-setup') {
      return Promise.resolve({ stdout: '', stderr: '', code: 2 });
    }
    if (joined === 'branch --show-current') {
      return Promise.resolve({ stdout: `${currentBranch}\n`, stderr: '', code: 0 });
    }
    if (joined === 'checkout -b chore/shipper-setup') {
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    }
    if (joined === 'add -A') {
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    }
    if (joined.startsWith('commit -m ')) {
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    }
    if (joined === 'push -u origin chore/shipper-setup') {
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    }

    throw new Error(`Unexpected git command: ${joined} (cwd: ${opts?.cwd ?? 'none'})`);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGetRepoRoot.mockResolvedValue('/repo');
  mockGetRepoNwo.mockResolvedValue('owner/repo');
  mockGetSettings.mockReturnValue({ defaultBaseBranch: 'main' });
  mockResolveBaseBranch.mockResolvedValue('main');
  mockSleepMs.mockResolvedValue();
  mockFetchChecks.mockResolvedValue([]);
  mockClassifyChecks.mockImplementation((checks) => ({
    pending: checks.filter((check) => check.bucket === 'pending'),
    failed: checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel'),
    passed: checks.filter((check) => check.bucket === 'pass'),
    total: checks.length,
  }));
  mockEnrichFailedChecks.mockResolvedValue(new Map());
  mockRunPrompt.mockResolvedValue(0);
  readFileMock.mockImplementation((filePath) =>
    Promise.resolve(Buffer.from(`content:${filePath}`))
  );
  mockGh.mockImplementation((args) => {
    const joined = args.join(' ');
    if (joined.startsWith('pr create ')) {
      return Promise.resolve({ stdout: 'https://github.com/owner/repo/pull/7\n', stderr: '' });
    }
    throw new Error(`Unexpected gh call: ${joined}`);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('readGitStatusSnapshot', () => {
  it('parses porcelain -z status into a stable snapshot', async () => {
    execAsyncMock.mockImplementation((_command, args) => {
      const joined = args.join(' ');
      if (joined === 'status --porcelain=v1 -z --untracked-files=all') {
        return Promise.resolve({
          stdout: '?? new-file.ts\0 M tracked.ts\0R  renamed.ts\0old-name.ts\0',
          stderr: '',
          code: 0,
        });
      }

      throw new Error(`Unexpected git command: ${joined}`);
    });

    const snapshot = await readGitStatusSnapshot(process.cwd());

    expect(snapshot.repoRoot).toBe('/repo');
    expect(snapshot.entries).toEqual([
      { path: 'new-file.ts', indexStatus: '?', worktreeStatus: '?' },
      { path: 'renamed.ts', indexStatus: 'R', worktreeStatus: ' ', originalPath: 'old-name.ts' },
      { path: 'tracked.ts', indexStatus: ' ', worktreeStatus: 'M' },
    ]);
  });
});

describe('offerSetupFinalize', () => {
  it('returns no-changes when setup did not introduce a snapshot delta', async () => {
    mockGitStatusFlow(['']);

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm: vi.fn(),
    });

    expect(result).toEqual({ status: 'no-changes' });
  });

  it('treats same-status content edits as setup-introduced changes', async () => {
    mockGitStatusFlow([' M tracked.ts\0']);
    readFileMock.mockResolvedValueOnce(Buffer.from('after-content'));
    const confirm = vi.fn().mockResolvedValue(false);

    const result = await offerSetupFinalize({
      before: makeSnapshot([
        { path: 'tracked.ts', indexStatus: ' ', worktreeStatus: 'M', contentSignature: 'before' },
      ]),
      mode: 'default',
      confirm,
    });

    expect(result).toEqual({ status: 'declined' });
    expect(confirm).toHaveBeenCalledWith('Finalize these setup changes in a PR? [y/N] ');
    expect(console.log).toHaveBeenCalledWith(
      '[shipper] Changes introduced or updated during setup:'
    );
    expect(console.log).toHaveBeenCalledWith('[shipper]   - tracked.ts');
  });

  it('shows the summary and leaves the working tree untouched when the user declines', async () => {
    mockGitStatusFlow(['?? after.ts\0']);
    const confirm = vi.fn().mockResolvedValue(false);

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm,
    });

    expect(result).toEqual({ status: 'declined' });
    expect(confirm).toHaveBeenCalledWith('Finalize these setup changes in a PR? [y/N] ');
    expect(execAsyncMock).not.toHaveBeenCalledWith(
      'git',
      ['checkout', '-b', 'chore/shipper-setup'],
      expect.anything()
    );
  });

  it('warns about files that were already dirty before setup', async () => {
    mockGitStatusFlow(['?? before.ts\0?? after.ts\0']);
    const confirm = vi.fn().mockResolvedValue(false);

    await offerSetupFinalize({
      before: makeSnapshot([
        { path: 'before.ts', contentSignature: hashSignature('content:/repo/before.ts') },
      ]),
      mode: 'default',
      confirm,
    });

    expect(console.log).toHaveBeenCalledWith(
      '[shipper] These files were already dirty before setup and will also be committed:'
    );
    expect(console.log).toHaveBeenCalledWith('[shipper]   - before.ts');
  });

  it('refuses cleanly when the local setup branch already exists', async () => {
    execAsyncMock.mockImplementation((_command, args) => {
      const joined = args.join(' ');
      if (joined === 'rev-parse --show-toplevel') {
        return Promise.resolve({ stdout: '/repo\n', stderr: '', code: 0 });
      }
      if (joined === 'status --porcelain=v1 -z --untracked-files=all') {
        return Promise.resolve({ stdout: '?? after.ts\0', stderr: '', code: 0 });
      }
      if (joined === 'rev-parse --verify chore/shipper-setup') {
        return Promise.resolve({ stdout: 'abc123\n', stderr: '', code: 0 });
      }
      if (joined === 'branch --show-current') {
        return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 });
      }

      throw new Error(`Unexpected git command: ${joined}`);
    });

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result).toEqual({ status: 'blocked-existing-branch' });
  });

  it('refuses cleanly when setup is run from a non-default branch', async () => {
    execAsyncMock.mockImplementation((_command, args) => {
      const joined = args.join(' ');
      if (joined === 'rev-parse --show-toplevel') {
        return Promise.resolve({ stdout: '/repo\n', stderr: '', code: 0 });
      }
      if (joined === 'status --porcelain=v1 -z --untracked-files=all') {
        return Promise.resolve({ stdout: '?? after.ts\0', stderr: '', code: 0 });
      }
      if (joined === 'branch --show-current') {
        return Promise.resolve({ stdout: 'feature-branch\n', stderr: '', code: 0 });
      }

      throw new Error(`Unexpected git command: ${joined}`);
    });

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result).toEqual({ status: 'blocked-base-branch' });
    expect(execAsyncMock).not.toHaveBeenCalledWith(
      'git',
      ['checkout', '-b', 'chore/shipper-setup'],
      expect.anything()
    );
  });

  it('refuses cleanly when the remote setup branch already exists', async () => {
    execAsyncMock.mockImplementation((_command, args) => {
      const joined = args.join(' ');
      if (joined === 'rev-parse --show-toplevel') {
        return Promise.resolve({ stdout: '/repo\n', stderr: '', code: 0 });
      }
      if (joined === 'status --porcelain=v1 -z --untracked-files=all') {
        return Promise.resolve({ stdout: '?? after.ts\0', stderr: '', code: 0 });
      }
      if (joined === 'rev-parse --verify chore/shipper-setup') {
        return Promise.resolve({ stdout: '', stderr: '', code: 1 });
      }
      if (joined === 'ls-remote --exit-code --heads origin chore/shipper-setup') {
        return Promise.resolve({
          stdout: 'abc123\trefs/heads/chore/shipper-setup\n',
          stderr: '',
          code: 0,
        });
      }
      if (joined === 'branch --show-current') {
        return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 });
      }

      throw new Error(`Unexpected git command: ${joined}`);
    });

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result).toEqual({ status: 'blocked-existing-branch' });
  });

  it('creates the branch, opens the PR, and reports success when checks pass', async () => {
    mockGitStatusFlow(['?? after.ts\0'], { currentBranch: 'develop' });
    mockGetSettings.mockReturnValue({ defaultBaseBranch: 'develop' });
    mockResolveBaseBranch.mockResolvedValueOnce('develop');
    mockFetchChecks
      .mockResolvedValueOnce([makeCheck('build', 'pending')])
      .mockResolvedValueOnce([makeCheck('build', 'pass')]);

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      agent: 'codex',
      model: 'gpt-5.4',
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result).toEqual({
      status: 'completed',
      prUrl: 'https://github.com/owner/repo/pull/7',
    });
    expect(execAsyncMock).toHaveBeenCalledWith('git', ['checkout', '-b', 'chore/shipper-setup'], {
      cwd: '/repo',
    });
    expect(mockGh).toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'create', '-R', 'owner/repo', '--base', 'develop']),
      { cwd: '/repo' }
    );
    expect(mockGh).not.toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'view']),
      expect.anything()
    );
    expect(execAsyncMock).toHaveBeenCalledWith(
      'git',
      ['push', '-u', 'origin', 'chore/shipper-setup'],
      { cwd: '/repo' }
    );
  });

  it('surfaces failing checks and stops when the user declines remediation', async () => {
    mockGitStatusFlow(['?? after.ts\0']);
    const failedCheck = makeCheck('lint', 'fail', {
      link: 'https://github.com/owner/repo/actions/runs/99/job/1',
    });
    mockFetchChecks.mockResolvedValueOnce([failedCheck]);

    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm,
    });

    expect(result).toEqual({
      status: 'completed',
      prUrl: 'https://github.com/owner/repo/pull/7',
    });
    expect(mockEnrichFailedChecks).toHaveBeenCalledWith('owner/repo', [failedCheck]);
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('runs one approved remediation pass, creates a follow-up commit, and re-polls checks', async () => {
    mockGitStatusFlow(['?? after.ts\0', ' M fixed.ts\0']);
    const failedCheck = makeCheck('lint', 'fail', {
      link: 'https://github.com/owner/repo/actions/runs/99/job/1',
    });
    mockFetchChecks
      .mockResolvedValueOnce([failedCheck])
      .mockResolvedValueOnce([makeCheck('lint', 'pass')]);

    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      agent: 'claude',
      model: 'opus',
      disableMcp: true,
      confirm,
    });

    expect(result).toEqual({
      status: 'completed',
      prUrl: 'https://github.com/owner/repo/pull/7',
    });
    expect(mockRunPrompt).toHaveBeenCalledWith(
      'setup_remediate',
      expect.objectContaining({
        repo: 'owner/repo',
        prRef: '7',
        cwd: '/repo',
        mode: 'default',
        agent: 'claude',
        model: 'opus',
        disableMcp: true,
      })
    );
    expect(execAsyncMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit', '-m', 'fix: address setup PR feedback']),
      { cwd: '/repo' }
    );
  });

  it('fails when an approved remediation prompt exits non-zero', async () => {
    mockGitStatusFlow(['?? after.ts\0']);
    mockFetchChecks.mockResolvedValueOnce([makeCheck('lint', 'fail')]);
    mockRunPrompt.mockResolvedValueOnce(2);

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
    });

    expect(result).toEqual({
      status: 'failed',
      prUrl: 'https://github.com/owner/repo/pull/7',
      error: 'setup_remediate exited with code 2',
    });
  });

  it('does not create an empty remediation commit when the pass leaves no diff', async () => {
    mockGitStatusFlow(['?? after.ts\0', '']);
    mockFetchChecks.mockResolvedValueOnce([makeCheck('lint', 'fail')]);

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
    });

    expect(result).toEqual({
      status: 'completed',
      prUrl: 'https://github.com/owner/repo/pull/7',
    });
    expect(execAsyncMock).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit', '-m', 'fix: address setup PR feedback']),
      { cwd: '/repo' }
    );
  });

  it('stops polling after repeated check fetch failures', async () => {
    mockGitStatusFlow(['?? after.ts\0']);
    mockFetchChecks.mockRejectedValue(new Error('network down'));

    const result = await offerSetupFinalize({
      before: makeSnapshot([]),
      mode: 'default',
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result).toEqual({
      status: 'completed',
      prUrl: 'https://github.com/owner/repo/pull/7',
    });
    expect(mockSleepMs).toHaveBeenCalledTimes(2);
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });
});
