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

beforeEach(() => {
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

    await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-add-reset'],
      }),
      'owner/repo'
    );

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

    await executeReset(
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

    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(closeIndex);
  });

  it('does not delete a PR branch when closing the PR fails', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'close') {
        return Promise.reject(new Error('close failed'));
      }

      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    await executeReset(
      18,
      makeScan({
        prs: [{ number: 101, headRefName: 'shipper/18-open-pr' }],
        branchesToDelete: ['shipper/18-open-pr'],
      }),
      'owner/repo'
    );

    expect(ghCalls()).not.toContainEqual([
      'api',
      '-X',
      'DELETE',
      'repos/owner/repo/git/refs/heads/shipper/18-open-pr',
    ]);
  });

  it('still deletes orphaned branches when an open PR branch remains blocked', async () => {
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

    await executeReset(
      18,
      makeScan({
        prs: [{ number: 101, headRefName: 'shipper/18-open-pr' }],
        branchesToDelete: ['shipper/18-open-pr', 'shipper/18-orphan'],
      }),
      'owner/repo'
    );

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

  it('does not delete a branch when branch-level PR verification finds an open PR', async () => {
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

    await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-open-pr'],
      }),
      'owner/repo'
    );

    expect(ghCalls()).not.toContainEqual([
      'api',
      '-X',
      'DELETE',
      'repos/owner/repo/git/refs/heads/shipper/18-open-pr',
    ]);
  });

  it('does not delete a branch when branch-level PR verification fails', async () => {
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

    await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-open-pr'],
      }),
      'owner/repo'
    );

    expect(ghCalls()).not.toContainEqual([
      'api',
      '-X',
      'DELETE',
      'repos/owner/repo/git/refs/heads/shipper/18-open-pr',
    ]);
  });

  it('does not call the branch delete API when implemented resets preserve branches', async () => {
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    await executeReset(
      18,
      makeScan({
        targetStage: 'implemented',
        targetLabel: 'shipper:implemented',
      }),
      'owner/repo'
    );

    expect(ghCalls().some((args) => args[0] === 'api' && args[2] === 'DELETE')).toBe(false);
  });

  it('logs the reset summary with the shipper prefix', async () => {
    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGh.mockImplementation((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'comment') {
        return Promise.resolve(ok());
      }

      return Promise.reject(new Error(`Unexpected gh call: ${args.join(' ')}`));
    });

    await executeReset(
      18,
      makeScan({
        labelsToRemove: ['shipper:planned'],
        addTarget: true,
        targetLabel: 'shipper:groomed',
      }),
      'owner/repo'
    );

    expect(logMock.mock.calls).toEqual([
      ['[shipper] \nReset complete for issue #18:'],
      ['[shipper]   ✓ Removed labels: shipper:planned'],
      ['[shipper]   ✓ Added label: shipper:groomed'],
      ['[shipper]   ✓ Posted reset notice comment'],
    ]);
  });

  it('warns with the shipper prefix when branch verification fails during reset', async () => {
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

    await executeReset(
      18,
      makeScan({
        branchesToDelete: ['shipper/18-open-pr'],
      }),
      'owner/repo'
    );

    expect(warnMock).toHaveBeenCalledWith(
      '[shipper]   Warning: Could not verify open PR state for branch shipper/18-open-pr: lookup failed'
    );
  });
});
