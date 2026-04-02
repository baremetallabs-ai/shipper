import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactScan } from '../../src/lib/reset.js';

const {
  mockGh,
  mockExecFileSync,
  mockExistsSync,
  mockReaddirSync,
  mockRm,
  mockHomedir,
  mockRemoveWorktree,
} = vi.hoisted(() => ({
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  mockExecFileSync: vi.fn<(command: string, args: string[], opts?: unknown) => string>(),
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockReaddirSync: vi.fn<(path: string, opts?: unknown) => unknown[]>(),
  mockRm: vi.fn<(path: string, opts?: unknown) => Promise<void>>(),
  mockHomedir: vi.fn<() => string>(),
  mockRemoveWorktree: vi.fn<(repoRoot: string, worktreePath: string) => Promise<void>>(),
}));

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => mockGh(...(args as [string[]])),
}));

vi.mock('../../src/lib/worktree.js', () => ({
  removeWorktree: (...args: unknown[]) =>
    mockRemoveWorktree(...(args as [repoRoot: string, worktreePath: string])),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) =>
      mockExecFileSync(...(args as [command: string, args: string[], opts?: unknown])),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...(args as [path: string])),
    readdirSync: (...args: unknown[]) =>
      mockReaddirSync(...(args as [path: string, opts?: unknown])),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rm: (...args: unknown[]) => mockRm(...(args as [path: string, opts?: unknown])),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockHomedir(),
  };
});

const { executeReset, scanArtifacts } = await import('../../src/lib/reset.js');

function ok(stdout = ''): { stdout: string; stderr: string } {
  return { stdout, stderr: '' };
}

function makeScan(overrides: Partial<ArtifactScan> = {}): ArtifactScan {
  return {
    labelsToRemove: [],
    addTarget: false,
    targetStage: 'new',
    targetLabel: 'shipper:new',
    commentIds: [],
    prs: [],
    branchesToDelete: [],
    localBranches: [],
    localWorktrees: [],
    ...overrides,
  };
}

function setupScanGh(
  options: { comments?: string; prs?: string; remoteRefs?: string; timeline?: string } = {}
): void {
  const { comments = '', prs = '[]', remoteRefs = '[]', timeline = '' } = options;
  mockGh.mockImplementation((args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      return Promise.resolve(ok(prs));
    }

    if (args[0] === 'api' && args[1]?.includes('/git/matching-refs/heads/shipper/')) {
      return Promise.resolve(ok(remoteRefs));
    }

    if (args[0] === 'api' && args[1]?.includes('/timeline')) {
      return Promise.resolve(ok(timeline));
    }

    if (args[0] === 'api' && args[1]?.includes('/comments')) {
      return Promise.resolve(ok(comments));
    }

    return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
  });
}

function setupScanExecFileSync(
  options: {
    remoteOutput?: string;
    localOutput?: string;
    currentBranch?: string;
    fetchError?: Error;
    remoteError?: Error;
  } = {}
): void {
  const {
    remoteOutput = '',
    localOutput = '',
    currentBranch = 'main\n',
    fetchError,
    remoteError,
  } = options;

  mockExecFileSync.mockImplementation((command: string, args: string[]) => {
    if (command !== 'git') {
      throw new Error(`Unexpected command: ${command}`);
    }

    if (args[0] === 'fetch') {
      if (fetchError) {
        throw fetchError;
      }
      return '';
    }

    if (args[0] === 'branch' && args[1] === '-r') {
      if (remoteError) {
        throw remoteError;
      }
      return remoteOutput;
    }

    if (args[0] === 'branch' && args[1] === '--list') {
      return localOutput;
    }

    if (args[0] === 'branch' && args[1] === '--show-current') {
      return currentBranch;
    }

    throw new Error(`Unexpected git args: ${args.join(' ')}`);
  });
}

function ghCalls(): string[][] {
  return mockGh.mock.calls.map(([args]) => args);
}

function getOperation(
  result: Awaited<ReturnType<typeof executeReset>>,
  description: string
): { description: string; status: string; reason?: string } {
  const operation = result.operations.find((entry) => entry.description === description);
  expect(operation).toBeDefined();
  return operation as { description: string; status: string; reason?: string };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  mockGh.mockReset();
  mockExecFileSync.mockReset();
  mockExistsSync.mockReset();
  mockReaddirSync.mockReset();
  mockRm.mockReset();
  mockHomedir.mockReset();
  mockRemoveWorktree.mockReset();

  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  mockRm.mockResolvedValue(undefined);
  mockHomedir.mockReturnValue('/home/test');
  mockRemoveWorktree.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scanArtifacts', () => {
  it('discovers a git-tracked remote branch when no open PR exists', async () => {
    setupScanGh();
    setupScanExecFileSync({
      remoteOutput: '  origin/shipper/18-add-reset\n',
    });

    const scan = await scanArtifacts(18, 'owner/repo', 'new', ['shipper:implemented'], {
      repoRoot: '/repo',
      repoName: 'shipper',
    });

    expect(scan.prs).toEqual([]);
    expect(scan.branchesToDelete).toEqual(['shipper/18-add-reset']);
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['fetch', 'origin', '--prune'], {
      cwd: '/repo',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-r', '--list', 'origin/shipper/18', 'origin/shipper/18-*'],
      {
        cwd: '/repo',
        encoding: 'utf-8',
      }
    );
  });

  it('merges PR-associated and orphaned remote branches without duplicates', async () => {
    setupScanGh({
      prs: JSON.stringify([{ number: 101, headRefName: 'shipper/18-open-pr' }]),
    });
    setupScanExecFileSync({
      remoteOutput: '  origin/shipper/18-open-pr\n  origin/shipper/18-orphan\n',
    });

    const scan = await scanArtifacts(18, 'owner/repo', 'new', ['shipper:implemented'], {
      repoRoot: '/repo',
      repoName: 'shipper',
    });

    expect(scan.prs).toEqual([{ number: 101, headRefName: 'shipper/18-open-pr' }]);
    expect(scan.branchesToDelete).toEqual(['shipper/18-open-pr', 'shipper/18-orphan']);
  });

  it('preserves remote branches when resetting to implemented', async () => {
    setupScanGh({
      prs: JSON.stringify([{ number: 101, headRefName: 'shipper/18-open-pr' }]),
    });

    const scan = await scanArtifacts(18, 'owner/repo', 'implemented', ['shipper:planned'], {
      repoRoot: '/repo',
      repoName: 'shipper',
    });

    expect(scan.prs).toEqual([{ number: 101, headRefName: 'shipper/18-open-pr' }]);
    expect(scan.branchesToDelete).toEqual([]);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns no remote branches to delete when none match the naming convention', async () => {
    setupScanGh();
    setupScanExecFileSync();

    const scan = await scanArtifacts(18, 'owner/repo', 'new', ['shipper:implemented'], {
      repoRoot: '/repo',
      repoName: 'shipper',
    });

    expect(scan.branchesToDelete).toEqual([]);
  });

  it('falls back to GitHub matching refs when no repoRoot is available', async () => {
    setupScanGh({
      remoteRefs: JSON.stringify([
        { ref: 'refs/heads/shipper/18' },
        { ref: 'refs/heads/shipper/18-add-reset' },
        { ref: 'refs/heads/shipper/180-keep-out' },
      ]),
    });

    const scan = await scanArtifacts(18, 'owner/repo', 'new', ['shipper:implemented'], {
      repoName: 'shipper',
    });

    expect(scan.branchesToDelete).toEqual(['shipper/18', 'shipper/18-add-reset']);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(ghCalls()).toContainEqual([
      'api',
      'repos/owner/repo/git/matching-refs/heads/shipper/18',
    ]);
  });

  it('tolerates git fetch failures and still scans stale remote refs', async () => {
    setupScanGh();
    setupScanExecFileSync({
      remoteOutput: '  origin/shipper/18-closed-pr\n',
      fetchError: new Error('fetch failed'),
    });

    const scan = await scanArtifacts(18, 'owner/repo', 'new', ['shipper:implemented'], {
      repoRoot: '/repo',
      repoName: 'shipper',
    });

    expect(scan.branchesToDelete).toEqual(['shipper/18-closed-pr']);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-r', '--list', 'origin/shipper/18', 'origin/shipper/18-*'],
      {
        cwd: '/repo',
        encoding: 'utf-8',
      }
    );
  });
});

describe('executeReset', () => {
  it('returns succeeded results for a fully successful reset', async () => {
    const worktreePath = '/home/test/.shipper/worktrees/repo--wt--shipper-18';
    const existingPaths = new Set([worktreePath]);

    mockExistsSync.mockImplementation((candidate: string) => existingPaths.has(candidate));
    mockRemoveWorktree.mockImplementation((_repoRoot: string, candidate: string) => {
      existingPaths.delete(candidate);
      return Promise.resolve();
    });
    mockExecFileSync.mockReturnValue('');
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'close') {
        return Promise.resolve(ok());
      }

      if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
        return Promise.resolve(ok());
      }

      if (args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'comment')) {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        localWorktrees: [worktreePath],
        localBranches: ['shipper/18-add-reset'],
        prs: [{ number: 101, headRefName: 'shipper/18-add-reset' }],
        branchesToDelete: ['shipper/18-add-reset'],
        commentIds: [3001],
        labelsToRemove: ['shipper:planned'],
        addTarget: true,
        targetStage: 'groomed',
        targetLabel: 'shipper:groomed',
      }),
      'owner/repo',
      { repoRoot: '/repo' }
    );

    expect(result).toEqual({
      operations: [
        { description: `Remove local worktree ${worktreePath}`, status: 'succeeded' },
        { description: 'Delete local branch shipper/18-add-reset', status: 'succeeded' },
        { description: 'Close PR #101', status: 'succeeded' },
        { description: 'Delete remote branch shipper/18-add-reset', status: 'succeeded' },
        { description: 'Delete comment 3001', status: 'succeeded' },
        { description: 'Remove labels: shipper:planned', status: 'succeeded' },
        { description: 'Add label: shipper:groomed', status: 'succeeded' },
        { description: 'Post reset notice comment', status: 'succeeded' },
      ],
      hasFailures: false,
    });
  });

  it('deletes an orphaned remote branch directly through the ref delete API', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'list' &&
        args[2] === '-R' &&
        args[3] === 'owner/repo' &&
        args[4] === '--head' &&
        args[5] === 'shipper/18-add-reset'
      ) {
        return Promise.resolve(ok('[]'));
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/git/refs/heads/shipper/18-add-reset'
      ) {
        return Promise.resolve(ok());
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-add-reset'],
      }),
      'owner/repo'
    );

    expect(getOperation(result, 'Delete remote branch shipper/18-add-reset')).toEqual({
      description: 'Delete remote branch shipper/18-add-reset',
      status: 'succeeded',
    });
    expect(result.hasFailures).toBe(false);
    expect(ghCalls()).toContainEqual([
      'pr',
      'list',
      '-R',
      'owner/repo',
      '--head',
      'shipper/18-add-reset',
      '--state',
      'open',
      '--json',
      'number,headRefName',
    ]);
    expect(ghCalls()).toContainEqual([
      'api',
      '-X',
      'DELETE',
      'repos/owner/repo/git/refs/heads/shipper/18-add-reset',
    ]);
  });

  it('deletes a PR branch only after the matching PR is closed', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'close') {
        return Promise.resolve(ok());
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/git/refs/heads/shipper/18-open-pr'
      ) {
        return Promise.resolve(ok());
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        prs: [{ number: 101, headRefName: 'shipper/18-open-pr' }],
        branchesToDelete: ['shipper/18-open-pr'],
      }),
      'owner/repo'
    );

    const closeIndex = ghCalls().findIndex(
      (args) => args[0] === 'pr' && args[1] === 'close' && args[2] === '101'
    );
    const deleteIndex = ghCalls().findIndex(
      (args) =>
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/git/refs/heads/shipper/18-open-pr'
    );

    expect(getOperation(result, 'Close PR #101')).toEqual({
      description: 'Close PR #101',
      status: 'succeeded',
    });
    expect(getOperation(result, 'Delete remote branch shipper/18-open-pr')).toEqual({
      description: 'Delete remote branch shipper/18-open-pr',
      status: 'succeeded',
    });
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(closeIndex);
  });

  it('reports an already closed PR as skipped and still deletes its branch', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'close') {
        return Promise.reject(new Error('PR is already closed'));
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/git/refs/heads/shipper/18-open-pr'
      ) {
        return Promise.resolve(ok());
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        prs: [{ number: 101, headRefName: 'shipper/18-open-pr' }],
        branchesToDelete: ['shipper/18-open-pr'],
      }),
      'owner/repo'
    );

    expect(getOperation(result, 'Close PR #101')).toEqual({
      description: 'Close PR #101',
      status: 'skipped',
      reason: 'already closed',
    });
    expect(getOperation(result, 'Delete remote branch shipper/18-open-pr')).toEqual({
      description: 'Delete remote branch shipper/18-open-pr',
      status: 'succeeded',
    });
    expect(result.hasFailures).toBe(false);
  });

  it('marks a failed PR close as a failure and still deletes orphaned branches', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'close') {
        return Promise.reject(new Error('close failed'));
      }

      if (
        args[0] === 'pr' &&
        args[1] === 'list' &&
        args[2] === '-R' &&
        args[3] === 'owner/repo' &&
        args[4] === '--head' &&
        args[5] === 'shipper/18-orphan'
      ) {
        return Promise.resolve(ok('[]'));
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/git/refs/heads/shipper/18-orphan'
      ) {
        return Promise.resolve(ok());
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        prs: [{ number: 101, headRefName: 'shipper/18-open-pr' }],
        branchesToDelete: ['shipper/18-open-pr', 'shipper/18-orphan'],
      }),
      'owner/repo'
    );

    expect(getOperation(result, 'Close PR #101')).toEqual({
      description: 'Close PR #101',
      status: 'failed',
      reason: 'close failed',
    });
    expect(getOperation(result, 'Delete remote branch shipper/18-open-pr')).toEqual({
      description: 'Delete remote branch shipper/18-open-pr',
      status: 'failed',
      reason: 'blocked because PR #101 could not be closed',
    });
    expect(getOperation(result, 'Delete remote branch shipper/18-orphan')).toEqual({
      description: 'Delete remote branch shipper/18-orphan',
      status: 'succeeded',
    });
    expect(result.hasFailures).toBe(true);
    expect(ghCalls()).toContainEqual([
      'api',
      '-X',
      'DELETE',
      'repos/owner/repo/git/refs/heads/shipper/18-orphan',
    ]);
    expect(ghCalls()).not.toContainEqual([
      'api',
      '-X',
      'DELETE',
      'repos/owner/repo/git/refs/heads/shipper/18-open-pr',
    ]);
  });

  it('records a failure when branch-level PR verification finds an open PR', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'list' &&
        args[2] === '-R' &&
        args[3] === 'owner/repo' &&
        args[4] === '--head' &&
        args[5] === 'shipper/18-open-pr'
      ) {
        return Promise.resolve(
          ok(JSON.stringify([{ number: 101, headRefName: 'shipper/18-open-pr' }]))
        );
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-open-pr'],
      }),
      'owner/repo'
    );

    expect(getOperation(result, 'Delete remote branch shipper/18-open-pr')).toEqual({
      description: 'Delete remote branch shipper/18-open-pr',
      status: 'failed',
      reason: 'still has an open PR: #101',
    });
    expect(result.hasFailures).toBe(true);
    expect(ghCalls()).not.toContainEqual([
      'api',
      '-X',
      'DELETE',
      'repos/owner/repo/git/refs/heads/shipper/18-open-pr',
    ]);
  });

  it('records a failure when branch-level PR verification fails', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'list' &&
        args[2] === '-R' &&
        args[3] === 'owner/repo' &&
        args[4] === '--head' &&
        args[5] === 'shipper/18-open-pr'
      ) {
        return Promise.reject(new Error('lookup failed'));
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-open-pr'],
      }),
      'owner/repo'
    );

    expect(getOperation(result, 'Delete remote branch shipper/18-open-pr')).toEqual({
      description: 'Delete remote branch shipper/18-open-pr',
      status: 'failed',
      reason: 'could not verify open PR state: lookup failed',
    });
    expect(result.hasFailures).toBe(true);
  });

  it('reports an already removed worktree as skipped', async () => {
    const result = await executeReset(
      18,
      makeScan({
        localWorktrees: ['/home/test/.shipper/worktrees/repo--wt--shipper-18'],
      }),
      'owner/repo'
    );

    expect(
      getOperation(
        result,
        'Remove local worktree /home/test/.shipper/worktrees/repo--wt--shipper-18'
      )
    ).toEqual({
      description: 'Remove local worktree /home/test/.shipper/worktrees/repo--wt--shipper-18',
      status: 'skipped',
      reason: 'already removed',
    });
    expect(result.hasFailures).toBe(false);
  });

  it('reports an already deleted local branch as skipped', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("error: branch 'shipper/18-add-reset' not found.");
    });
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        localBranches: ['shipper/18-add-reset'],
      }),
      'owner/repo',
      { repoRoot: '/repo' }
    );

    expect(getOperation(result, 'Delete local branch shipper/18-add-reset')).toEqual({
      description: 'Delete local branch shipper/18-add-reset',
      status: 'skipped',
      reason: 'already deleted',
    });
    expect(result.hasFailures).toBe(false);
  });

  it('reports an already deleted remote branch as skipped', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'list' &&
        args[2] === '-R' &&
        args[3] === 'owner/repo' &&
        args[4] === '--head' &&
        args[5] === 'shipper/18-add-reset'
      ) {
        return Promise.resolve(ok('[]'));
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/git/refs/heads/shipper/18-add-reset'
      ) {
        return Promise.reject(new Error('Reference does not exist'));
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-add-reset'],
      }),
      'owner/repo'
    );

    expect(getOperation(result, 'Delete remote branch shipper/18-add-reset')).toEqual({
      description: 'Delete remote branch shipper/18-add-reset',
      status: 'skipped',
      reason: 'already deleted',
    });
    expect(result.hasFailures).toBe(false);
  });

  it('reports an already deleted comment as skipped', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/issues/comments/101'
      ) {
        return Promise.reject(new Error('HTTP 404'));
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        commentIds: [101],
      }),
      'owner/repo'
    );

    expect(getOperation(result, 'Delete comment 101')).toEqual({
      description: 'Delete comment 101',
      status: 'skipped',
      reason: 'already deleted',
    });
    expect(result.hasFailures).toBe(false);
  });

  it('records failures without stopping later operations', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (
        args[0] === 'pr' &&
        args[1] === 'list' &&
        args[2] === '-R' &&
        args[3] === 'owner/repo' &&
        args[4] === '--head' &&
        args[5] === 'shipper/18-add-reset'
      ) {
        return Promise.resolve(ok('[]'));
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/git/refs/heads/shipper/18-add-reset'
      ) {
        return Promise.reject(new Error('network error'));
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        args[3] === 'repos/owner/repo/issues/comments/101'
      ) {
        return Promise.resolve(ok());
      }

      if (args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'comment')) {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-add-reset'],
        commentIds: [101],
        labelsToRemove: ['shipper:planned'],
        addTarget: true,
        targetLabel: 'shipper:groomed',
      }),
      'owner/repo'
    );

    expect(getOperation(result, 'Delete remote branch shipper/18-add-reset')).toEqual({
      description: 'Delete remote branch shipper/18-add-reset',
      status: 'failed',
      reason: 'network error',
    });
    expect(getOperation(result, 'Delete comment 101')).toEqual({
      description: 'Delete comment 101',
      status: 'succeeded',
    });
    expect(getOperation(result, 'Remove labels: shipper:planned')).toEqual({
      description: 'Remove labels: shipper:planned',
      status: 'succeeded',
    });
    expect(getOperation(result, 'Add label: shipper:groomed')).toEqual({
      description: 'Add label: shipper:groomed',
      status: 'succeeded',
    });
    expect(getOperation(result, 'Post reset notice comment')).toEqual({
      description: 'Post reset notice comment',
      status: 'succeeded',
    });
    expect(result.hasFailures).toBe(true);
  });

  it('does not call the branch delete API when implemented resets preserve branches', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    const result = await executeReset(
      18,
      makeScan({
        targetStage: 'implemented',
        targetLabel: 'shipper:implemented',
      }),
      'owner/repo'
    );

    expect(result.operations).toEqual([
      { description: 'Post reset notice comment', status: 'succeeded' },
    ]);
    expect(ghCalls().some((args) => args[0] === 'api' && args[2] === 'DELETE')).toBe(false);
  });
});
