import { beforeEach, describe, expect, it, vi } from 'vitest';

type ErrnoError = Error & { code?: string };

const {
  mockConfirm,
  mockPromptChoice,
  mockGetRepoNwo,
  mockGetRepoRoot,
  mockRemoveWorktree,
  mockExecFileSync,
  mockGh,
  mockIsLockStale,
  mockReaddirSync,
  mockExistsSync,
  mockHomedir,
} = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockPromptChoice: vi.fn(),
  mockGetRepoNwo: vi.fn(() => 'owner/repo'),
  mockGetRepoRoot: vi.fn(async () => '/tmp/fake-repo'),
  mockRemoveWorktree: vi.fn(async () => {}),
  mockExecFileSync: vi.fn(),
  mockGh: vi.fn(),
  mockIsLockStale: vi.fn(() => true),
  mockReaddirSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockHomedir: vi.fn(() => '/tmp/home'),
}));

vi.mock('../../src/lib/confirm.js', () => ({
  confirm: mockConfirm,
  promptChoice: mockPromptChoice,
}));

vi.mock('@dnsquared/shipper-core', () => ({
  getRepoNwo: () => mockGetRepoNwo(),
  getRepoRoot: () => mockGetRepoRoot(),
  gh: (...args: unknown[]) => mockGh(...args),
  isLockStale: (...args: unknown[]) => mockIsLockStale(...args),
  removeWorktree: (...args: unknown[]) => mockRemoveWorktree(...args),
  STAGE_LABEL_NAMES: [
    'shipper:new',
    'shipper:groomed',
    'shipper:designed',
    'shipper:planned',
    'shipper:implemented',
    'shipper:pr-open',
    'shipper:pr-reviewed',
    'shipper:ready',
  ],
  IMPLEMENTED_LABEL: 'shipper:implemented',
  BLOCKED_LABEL: 'shipper:blocked',
  FAILED_LABEL: 'shipper:failed',
  LOCKED_LABEL: 'shipper:locked',
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('node:fs', () => ({
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => mockHomedir(),
}));

import { resetCommand } from '../../src/commands/reset.js';

const _mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  mockPromptChoice.mockResolvedValue('1');
  mockIsLockStale.mockReturnValue(true);
  mockGetRepoRoot.mockResolvedValue('/tmp/fake-repo');
  mockRemoveWorktree.mockResolvedValue(undefined);
  mockReaddirSync.mockReturnValue([]);
  mockExistsSync.mockReturnValue(false);
  mockHomedir.mockReturnValue('/tmp/home');
});

function mockIssueView(state: string, labels: string[]) {
  return JSON.stringify({
    number: 18,
    state,
    labels: labels.map((name) => ({ name })),
  });
}

function setupExecMock(overrides?: {
  issueJson?: string;
  commentIds?: string;
  prJson?: string;
  commentsWithDates?: string;
  timelineByStage?: Record<string, string>;
  gitCommonDir?: string;
  gitCommonDirError?: string;
  localBranchesOutput?: string;
  currentBranch?: string;
  showCurrentError?: string;
  deleteLocalBranchErrors?: Record<string, string>;
  worktreeEntries?: Array<{ name: string; isDirectory?: boolean }>;
  worktreeReadError?: ErrnoError;
  existingPaths?: string[];
  persistentWorktreePaths?: string[];
  operationLog?: string[];
}) {
  const issueJson = overrides?.issueJson ?? mockIssueView('OPEN', ['shipper:planned']);
  const commentIds = overrides?.commentIds ?? '';
  const prJson = overrides?.prJson ?? '[]';
  const commentsWithDates = overrides?.commentsWithDates ?? '';
  const timelineByStage = overrides?.timelineByStage ?? {};
  const gitCommonDir = overrides?.gitCommonDir ?? '/tmp/fake-repo/.git';
  const localBranchesOutput = overrides?.localBranchesOutput ?? '';
  const currentBranch = overrides?.currentBranch ?? '';
  const deleteLocalBranchErrors = overrides?.deleteLocalBranchErrors ?? {};
  const operationLog = overrides?.operationLog;
  const existingPaths = new Set(overrides?.existingPaths ?? []);
  const persistentWorktreePaths = new Set(overrides?.persistentWorktreePaths ?? []);

  mockGh.mockImplementation(async (args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      return { stdout: issueJson, stderr: '' };
    }

    if (args[0] === 'api' && typeof args[1] === 'string' && args[1].includes('/timeline')) {
      const jqIndex = args.indexOf('--jq');
      const jq = jqIndex === -1 ? '' : (args[jqIndex + 1] ?? '');
      const match = jq.match(/shipper:([a-z-]+)/);
      const stage = match?.[1];
      return { stdout: stage ? (timelineByStage[stage] ?? '') : '', stderr: '' };
    }

    if (
      args[0] === 'api' &&
      typeof args[1] === 'string' &&
      args[1].includes('/comments') &&
      !args.includes('DELETE')
    ) {
      const jqIndex = args.indexOf('--jq');
      const jq = jqIndex === -1 ? '' : (args[jqIndex + 1] ?? '');
      return { stdout: jq.includes('created_at') ? commentsWithDates : commentIds, stderr: '' };
    }

    if (args[0] === 'pr' && args[1] === 'list') return { stdout: prJson, stderr: '' };

    if (args[0] === 'pr' && args[1] === 'close') {
      operationLog?.push(`gh pr close ${args[2]}`);
      return { stdout: '', stderr: '' };
    }

    if (args[0] === 'api' && args.includes('DELETE')) {
      operationLog?.push(`gh delete comment ${args[3]}`);
      return { stdout: '', stderr: '' };
    }

    if (args[0] === 'issue' && args[1] === 'edit') {
      operationLog?.push('gh issue edit');
      return { stdout: '', stderr: '' };
    }

    if (args[0] === 'issue' && args[1] === 'comment') {
      operationLog?.push('gh issue comment');
      return { stdout: '', stderr: '' };
    }

    return { stdout: '', stderr: '' };
  });

  mockReaddirSync.mockImplementation(() => {
    if (overrides?.worktreeReadError) {
      throw overrides.worktreeReadError;
    }

    return (overrides?.worktreeEntries ?? []).map((entry) => ({
      name: entry.name,
      isDirectory: () => entry.isDirectory ?? true,
    }));
  });

  mockExistsSync.mockImplementation((candidate: string) => existingPaths.has(candidate));

  mockRemoveWorktree.mockImplementation(async (_repoRoot: string, wtPath: string) => {
    operationLog?.push(`removeWorktree ${wtPath}`);
    if (!persistentWorktreePaths.has(wtPath)) {
      existingPaths.delete(wtPath);
    }
  });

  mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd !== 'git') {
      return '';
    }

    if (args[0] === 'branch' && args[1] === '--list') {
      operationLog?.push('git branch --list');
      return localBranchesOutput;
    }

    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      operationLog?.push('git rev-parse --git-common-dir');
      if (overrides?.gitCommonDirError) {
        throw new Error(overrides.gitCommonDirError);
      }
      return gitCommonDir;
    }

    if (args[0] === 'branch' && args[1] === '--show-current') {
      operationLog?.push('git branch --show-current');
      if (overrides?.showCurrentError) {
        throw new Error(overrides.showCurrentError);
      }
      return currentBranch;
    }

    if (args[0] === 'branch' && args[1] === '-D') {
      const branch = args[2];
      if (!branch) {
        throw new Error('Missing branch name');
      }
      operationLog?.push(`git branch -D ${branch}`);
      const error = deleteLocalBranchErrors[branch];
      if (error) {
        throw new Error(error);
      }
      return '';
    }

    if (args[0] === 'push' && args[1] === 'origin' && args[2] === '--delete') {
      operationLog?.push(`git push origin --delete ${args[3]}`);
      return '';
    }

    return '';
  });
}

function getIssueEditArgs(): string[] {
  const call = mockGh.mock.calls.find(
    ([args]) => (args as string[])[0] === 'issue' && (args as string[])[1] === 'edit'
  );

  return call?.[0] as string[];
}

function getIssueCommentBody(): string {
  const call = mockGh.mock.calls.find(
    ([args]) => (args as string[])[0] === 'issue' && (args as string[])[1] === 'comment'
  );

  return ((call?.[0] as string[]) ?? [])[4] ?? '';
}

function getLocalWorktreePath(name: string): string {
  return `/tmp/home/.shipper/worktrees/${name}`;
}

describe('resetCommand', () => {
  it('exits with error for invalid issue number', async () => {
    await expect(resetCommand('abc', { force: true })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Please provide a valid issue number.');
    expect(mockConsoleError).toHaveBeenCalledWith('Usage: shipper reset <issue> [--to <stage>]');
  });

  it('rejects partial numeric input like 18foo', async () => {
    await expect(resetCommand('18foo', { force: true })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Please provide a valid issue number.');
  });

  it('exits with error for closed issues', async () => {
    setupExecMock({ issueJson: mockIssueView('CLOSED', ['shipper:groomed']) });
    await expect(resetCommand('18', { force: true })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Issue #18 is closed. Reset only works on open issues.'
    );
  });

  it('strips # prefix from issue number', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:new', 'shipper:groomed']),
    });
    await resetCommand('#18', { force: true, to: 'new' });
    expect(mockGh).toHaveBeenCalledWith(['issue', 'view', '18', '--json', 'number,state,labels']);
  });

  it('blocks reset when shipper:locked is present and lock is not stale', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:locked']),
    });
    mockIsLockStale.mockReturnValue(false);

    await expect(resetCommand('18', { force: false, to: 'new' })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Issue #18 is locked by another shipper instance. Use --force to override.'
    );
  });

  it('allows reset with --force when shipper:locked is present', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:locked']),
    });

    await resetCommand('18', { force: true, to: 'new' });
    expect(mockIsLockStale).not.toHaveBeenCalled();
  });

  it('allows reset when lock is stale', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:locked']),
    });
    mockIsLockStale.mockReturnValue(true);

    await resetCommand('18', { force: false, to: 'new' });

    expect(mockIsLockStale).toHaveBeenCalledWith('owner/repo', '18');
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('locked by another shipper instance')
    );
  });

  it('skips target selection when --to is provided', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      timelineByStage: { groomed: '2024-01-15T12:00:00Z\n' },
    });

    await resetCommand('18', { force: true, to: 'groomed' });

    expect(mockPromptChoice).not.toHaveBeenCalled();
  });

  it('accepts short stage names with --to', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
      ]),
      timelineByStage: { groomed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '{"id":201,"created_at":"2024-01-15T12:00:01Z"}\n',
    });

    await resetCommand('18', { force: true, to: 'groomed' });

    expect(mockConsoleLog).toHaveBeenCalledWith('  Target: shipper:groomed');
    const editArgs = getIssueEditArgs();
    expect(editArgs).toContain('--remove-label');
    expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe(
      'shipper:designed,shipper:planned'
    );
  });

  it('accepts full shipper label names with --to', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
      ]),
      timelineByStage: { designed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '{"id":202,"created_at":"2024-01-15T12:00:01Z"}\n',
    });

    await resetCommand('18', { force: true, to: 'shipper:designed' });

    expect(mockConsoleLog).toHaveBeenCalledWith('  Target: shipper:designed');
    const editArgs = getIssueEditArgs();
    expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe('shipper:planned');
  });

  it('removes shipper:failed on non-new resets', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:designed', 'shipper:failed']),
      timelineByStage: { groomed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '{"id":203,"created_at":"2024-01-15T12:00:01Z"}\n',
    });

    await resetCommand('18', { force: true, to: 'groomed' });

    const editArgs = getIssueEditArgs();
    expect(editArgs).toContain('--remove-label');
    expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe(
      'shipper:designed,shipper:failed'
    );
  });

  it('still removes shipper:failed when resetting to new', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:new', 'shipper:planned', 'shipper:failed']),
      commentIds: '101\n',
    });

    await resetCommand('18', { force: true, to: 'new' });

    const editArgs = getIssueEditArgs();
    expect(editArgs).toContain('--remove-label');
    expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe('shipper:planned,shipper:failed');
  });

  it('shows all earlier workflow stages for a planned issue', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      timelineByStage: { new: '' },
    });
    mockPromptChoice.mockResolvedValue('2');

    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith('\nReset targets:');
    expect(mockConsoleLog).toHaveBeenCalledWith('  1) new');
    expect(mockConsoleLog).toHaveBeenCalledWith('  2) groomed');
    expect(mockConsoleLog).toHaveBeenCalledWith('  3) designed');
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-3]: ', ['1', '2', '3']);
  });

  it('shows a single valid target and still prompts for a groomed issue', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed']),
      commentIds: '101\n',
    });

    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith('  1) new');
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-1]: ', ['1']);
  });

  it('includes implemented as a valid target when PR-stage labels are present', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
    });
    mockPromptChoice.mockResolvedValue('5');

    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith('  1) new');
    expect(mockConsoleLog).toHaveBeenCalledWith('  2) groomed');
    expect(mockConsoleLog).toHaveBeenCalledWith('  3) designed');
    expect(mockConsoleLog).toHaveBeenCalledWith('  4) planned');
    expect(mockConsoleLog).toHaveBeenCalledWith('  5) implemented');
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-5]: ', ['1', '2', '3', '4', '5']);
  });

  it('treats PR-stage labels as post-implemented even when implemented is missing', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned', 'shipper:pr-open']),
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
    });
    mockPromptChoice.mockResolvedValue('5');

    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith('  1) new');
    expect(mockConsoleLog).toHaveBeenCalledWith('  2) groomed');
    expect(mockConsoleLog).toHaveBeenCalledWith('  3) designed');
    expect(mockConsoleLog).toHaveBeenCalledWith('  4) planned');
    expect(mockConsoleLog).toHaveBeenCalledWith('  5) implemented');
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-5]: ', ['1', '2', '3', '4', '5']);
  });

  it('still prompts for target selection with --force when --to is absent', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
    });

    await resetCommand('18', { force: true });

    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-3]: ', ['1', '2', '3']);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('skips both prompts when --to and --force are provided together', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      timelineByStage: { groomed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
    });

    await resetCommand('18', { force: true, to: 'groomed' });

    expect(mockPromptChoice).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('prompts for confirmation without --force', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
    });

    await resetCommand('18', { force: false });

    expect(mockConfirm).toHaveBeenCalledWith('Proceed? (y/N): ');
  });

  it('cancels when user declines confirmation', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
    });
    mockConfirm.mockResolvedValue(false);

    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith('Reset cancelled.');
    const deleteCalls = mockGh.mock.calls.filter(([args]) => (args as string[]).includes('DELETE'));
    expect(deleteCalls).toHaveLength(0);
  });

  it('prints the dry-run summary before confirmation', async () => {
    const localWorktree = getLocalWorktreePath('fake-repo--wt--shipper-18-add-reset');
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
      ]),
      timelineByStage: { groomed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates:
        '{"id":101,"created_at":"2024-01-15T12:01:01Z"}\n{"id":102,"created_at":"2024-01-15T12:01:02Z"}\n',
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
      localBranchesOutput: '  shipper/18-add-reset\n',
      worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-add-reset' }],
    });
    mockConfirm.mockResolvedValue(false);
    mockPromptChoice.mockResolvedValue('2');

    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith('\nReset summary for issue #18:');
    expect(mockConsoleLog).toHaveBeenCalledWith('  Target: shipper:groomed');
    expect(mockConsoleLog).toHaveBeenCalledWith(
      '  Labels to remove: shipper:designed, shipper:planned'
    );
    expect(mockConsoleLog).toHaveBeenCalledWith('  Comments to delete: 2');
    expect(mockConsoleLog).toHaveBeenCalledWith('  PRs to close: #42');
    expect(mockConsoleLog).toHaveBeenCalledWith(
      '  Remote branches to delete: shipper/18-add-reset'
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(`  Local worktrees to remove: ${localWorktree}`);
    expect(mockConsoleLog).toHaveBeenCalledWith('  Local branches to delete: shipper/18-add-reset');
  });

  it('leaves local cleanup inactive when no local artifacts exist', async () => {
    const missingDirError = new Error('missing') as ErrnoError;
    missingDirError.code = 'ENOENT';

    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
      worktreeReadError: missingDirError,
    });

    await resetCommand('18', { force: true, to: 'new' });

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', expect.any(String)],
      expect.any(Object)
    );
    expect(mockConsoleWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not scan local worktrees')
    );
    expect(mockConsoleWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipping local branch')
    );
  });

  it('warns and skips deleting the checked-out local branch while continuing reset cleanup', async () => {
    const localWorktree = getLocalWorktreePath('fake-repo--wt--shipper-18-add-reset');
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
      ]),
      timelineByStage: { planned: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
      localBranchesOutput: '* shipper/18-add-reset\n',
      currentBranch: 'shipper/18-add-reset',
      worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-add-reset' }],
      existingPaths: [localWorktree],
    });

    await resetCommand('18', { force: true, to: 'planned' });

    expect(mockConsoleWarn).toHaveBeenCalledWith(
      'Warning: Skipping local branch shipper/18-add-reset because it is currently checked out.'
    );
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/fake-repo', localWorktree);
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'shipper/18-add-reset'],
      expect.any(Object)
    );
    expect(mockGh).toHaveBeenCalledWith(['pr', 'close', '42']);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', '--delete', 'shipper/18-add-reset'],
      expect.any(Object)
    );
    expect(getIssueCommentBody()).toContain('This issue has been reset to `shipper:planned`.');
  });

  it('executes local and remote cleanup in the expected order', async () => {
    const operations: string[] = [];
    const localWorktree = getLocalWorktreePath('fake-repo--wt--shipper-18-add-reset');
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:groomed',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:locked',
      ]),
      commentIds: '101\n',
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
      localBranchesOutput: '  shipper/18-add-reset\n',
      currentBranch: 'main',
      worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-add-reset' }],
      existingPaths: [localWorktree],
      operationLog: operations,
    });

    await resetCommand('18', { force: true, to: 'new' });

    expect(operations.indexOf(`removeWorktree ${localWorktree}`)).toBeLessThan(
      operations.indexOf('git branch -D shipper/18-add-reset')
    );
    expect(operations.indexOf('git branch -D shipper/18-add-reset')).toBeLessThan(
      operations.indexOf('gh pr close 42')
    );
    expect(operations.indexOf('gh pr close 42')).toBeLessThan(
      operations.indexOf('git push origin --delete shipper/18-add-reset')
    );
  });

  it('removes a worktree even when the local branch is already gone', async () => {
    const localWorktree = getLocalWorktreePath('fake-repo--wt--shipper-18-add-reset');
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '',
      worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-add-reset' }],
      existingPaths: [localWorktree],
    });

    await resetCommand('18', { force: true, to: 'new' });

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/fake-repo', localWorktree);
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', expect.any(String)],
      expect.any(Object)
    );
  });

  it('deletes a local branch even when the worktree is already gone', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '',
      localBranchesOutput: '  shipper/18-add-reset\n',
      currentBranch: 'main',
    });

    await resetCommand('18', { force: true, to: 'new' });

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'shipper/18-add-reset'],
      expect.objectContaining({
        cwd: '/tmp/fake-repo',
        stdio: ['ignore', 'ignore', 'ignore'],
      })
    );
  });

  it('strips linked-worktree + markers before deleting local branches', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '',
      localBranchesOutput: '+ shipper/18-add-reset\n',
      currentBranch: 'main',
    });

    await resetCommand('18', { force: true, to: 'new' });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'shipper/18-add-reset'],
      expect.objectContaining({
        cwd: '/tmp/fake-repo',
        stdio: ['ignore', 'ignore', 'ignore'],
      })
    );
  });

  it('derives the worktree repo prefix from the git common dir when running inside a worktree', async () => {
    const siblingWorktree = getLocalWorktreePath('fake-repo--wt--shipper-18-other');
    mockGetRepoRoot.mockResolvedValue(
      '/tmp/home/.shipper/worktrees/fake-repo--wt--shipper-18-add-reset'
    );
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '',
      gitCommonDir: '/tmp/fake-repo/.git',
      worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-other' }],
      existingPaths: [siblingWorktree],
    });

    await resetCommand('18', { force: true, to: 'new' });

    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      '/tmp/home/.shipper/worktrees/fake-repo--wt--shipper-18-add-reset',
      siblingWorktree
    );
  });

  it('warns on local cleanup failures and still completes the rest of the reset', async () => {
    const localWorktree = getLocalWorktreePath('fake-repo--wt--shipper-18-add-reset');
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
      ]),
      timelineByStage: { planned: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '{"id":101,"created_at":"2024-01-15T12:01:01Z"}\n',
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
      localBranchesOutput: '  shipper/18-add-reset\n',
      currentBranch: 'main',
      worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-add-reset' }],
      existingPaths: [localWorktree],
      persistentWorktreePaths: [localWorktree],
      deleteLocalBranchErrors: { 'shipper/18-add-reset': 'branch delete failed' },
    });

    await resetCommand('18', { force: true, to: 'planned' });

    expect(mockConsoleWarn).toHaveBeenCalledWith(
      `  Warning: Failed to remove local worktree ${localWorktree}.`
    );
    expect(mockConsoleWarn).toHaveBeenCalledWith(
      '  Warning: Failed to delete local branch shipper/18-add-reset: branch delete failed'
    );
    expect(mockGh).toHaveBeenCalledWith(['pr', 'close', '42']);
    expect(mockGh).toHaveBeenCalledWith([
      'api',
      '-X',
      'DELETE',
      'repos/owner/repo/issues/comments/101',
    ]);
    expect(getIssueEditArgs()).toContain('--remove-label');
    expect(mockConsoleLog).toHaveBeenCalledWith(
      '  ✓ Deleted remote branches: shipper/18-add-reset'
    );
    expect(getIssueCommentBody()).toContain('This issue has been reset to `shipper:planned`.');
  });

  it('rejects resetting to the current stage', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed']),
    });

    await expect(resetCommand('18', { force: true, to: 'groomed' })).rejects.toThrow(
      'process.exit'
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: Issue #18 is already at shipper:groomed. Reset only works backward.'
    );
  });

  it('rejects resetting to a later stage', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed']),
    });

    await expect(resetCommand('18', { force: true, to: 'designed' })).rejects.toThrow(
      'process.exit'
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: shipper:designed is ahead of the current stage shipper:groomed. Reset only works backward.'
    );
  });

  it('rejects non-workflow stage names', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
    });

    await expect(resetCommand('18', { force: true, to: 'blocked' })).rejects.toThrow(
      'process.exit'
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: blocked is not a valid workflow stage. Valid stages: new, groomed, designed, planned, implemented.'
    );
  });

  it('rejects non-workflow shipper labels', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
    });

    await expect(resetCommand('18', { force: true, to: 'shipper:blocked' })).rejects.toThrow(
      'process.exit'
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: shipper:blocked is not a valid workflow stage. Valid stages: new, groomed, designed, planned, implemented.'
    );
  });

  it('rejects invalid stage names', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
    });

    await expect(resetCommand('18', { force: true, to: 'banana' })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: banana is not a valid stage name. Valid stages: new, groomed, designed, planned, implemented.'
    );
  });

  it('removes only later workflow labels and PR labels for an intermediate target', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:blocked',
        'shipper:locked',
      ]),
      timelineByStage: { groomed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
    });

    await resetCommand('18', { force: true, to: 'groomed' });

    const editArgs = getIssueEditArgs();
    expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe(
      'shipper:designed,shipper:planned,shipper:implemented,shipper:pr-open'
    );
    expect(editArgs).not.toContain('--add-label');
  });

  it('preserves comments within 60 seconds after the target stage label timestamp', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
      ]),
      timelineByStage: { designed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates:
        '{"id":301,"created_at":"2024-01-15T12:00:30Z"}\n' +
        '{"id":302,"created_at":"2024-01-15T12:01:00Z"}\n' +
        '{"id":303,"created_at":"2024-01-15T12:01:01Z"}\n',
    });

    await resetCommand('18', { force: true, to: 'designed' });

    const deleteCalls = mockGh.mock.calls.filter(([args]) => (args as string[]).includes('DELETE'));
    expect(deleteCalls).toHaveLength(1);
    const firstDeleteCall = deleteCalls[0]?.[0] as string[] | undefined;
    expect(firstDeleteCall).toBeDefined();
    expect(firstDeleteCall?.[3]).toBe('repos/owner/repo/issues/comments/303');
  });

  it('deletes all comments when resetting to new', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed']),
      commentIds: '401\n402\n403\n',
    });

    await resetCommand('18', { force: true, to: 'new' });

    const deleteCalls = mockGh.mock.calls.filter(([args]) => (args as string[]).includes('DELETE'));
    expect(deleteCalls).toHaveLength(3);
  });

  it('removes blocked and locked labels when resetting to new', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:blocked',
        'shipper:locked',
      ]),
      commentIds: '',
    });

    await resetCommand('18', { force: true, to: 'new' });

    const editArgs = getIssueEditArgs();
    expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe(
      'shipper:groomed,shipper:blocked,shipper:locked'
    );
  });

  it('preserves branches while cleaning up implemented-target artifacts', async () => {
    const localWorktree = getLocalWorktreePath('fake-repo--wt--shipper-18-add-reset');
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
      ]),
      prJson: JSON.stringify([
        { number: 42, headRefName: 'shipper/18-add-reset' },
        { number: 43, headRefName: '18-scratch-branch' },
      ]),
      localBranchesOutput: '  shipper/18-add-reset\n',
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
      commentsWithDates:
        '{"id":501,"created_at":"2024-01-15T12:00:30Z"}\n' +
        '{"id":502,"created_at":"2024-01-15T12:01:01Z"}\n',
      worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-add-reset' }],
      existingPaths: [localWorktree],
    });

    await resetCommand('18', { force: true, to: 'implemented' });

    const editArgs = getIssueEditArgs();
    expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe('shipper:pr-open');
    expect(editArgs).not.toContain('--add-label');

    const closeCalls = mockGh.mock.calls.filter(
      ([args]) => (args as string[])[0] === 'pr' && (args as string[])[1] === 'close'
    );
    expect(closeCalls).toHaveLength(2);

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/fake-repo', localWorktree);
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['branch', '--list', 'shipper/18', 'shipper/18-*'],
      expect.any(Object)
    );
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'shipper/18-add-reset'],
      expect.any(Object)
    );
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['push', 'origin', '--delete', 'shipper/18-add-reset'],
      expect.any(Object)
    );

    const deleteCalls = mockGh.mock.calls.filter(([args]) => (args as string[]).includes('DELETE'));
    expect(deleteCalls).toHaveLength(1);
    const firstDeleteCall = deleteCalls[0]?.[0] as string[] | undefined;
    expect(firstDeleteCall).toBeDefined();
    expect(firstDeleteCall?.[3]).toBe('repos/owner/repo/issues/comments/502');
  });

  it.each([
    ['pr-open', 'shipper:pr-open'],
    ['pr-reviewed', 'shipper:pr-reviewed'],
  ])(
    'preserves remote and local branches when resetting %s back to implemented',
    async (_stage, label) => {
      const localWorktree = getLocalWorktreePath('fake-repo--wt--shipper-18-add-reset');
      setupExecMock({
        issueJson: mockIssueView('OPEN', ['shipper:implemented', label]),
        prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
        localBranchesOutput: '  shipper/18-add-reset\n',
        timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
        commentsWithDates: '',
        worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-add-reset' }],
        existingPaths: [localWorktree],
      });
      mockConfirm.mockResolvedValue(false);

      await resetCommand('18', { force: false, to: 'implemented' });
      await resetCommand('18', { force: true, to: 'implemented' });

      expect(mockConsoleLog).toHaveBeenCalledWith('\nReset summary for issue #18:');
      expect(mockConsoleLog).not.toHaveBeenCalledWith(
        '  Remote branches to delete: shipper/18-add-reset'
      );
      expect(mockConsoleLog).not.toHaveBeenCalledWith(
        '  Local branches to delete: shipper/18-add-reset'
      );
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        ['branch', '--list', 'shipper/18', 'shipper/18-*'],
        expect.any(Object)
      );
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        ['push', 'origin', '--delete', 'shipper/18-add-reset'],
        expect.any(Object)
      );
      expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/fake-repo', localWorktree);
      expect(mockGh).toHaveBeenCalledWith(['pr', 'close', '42']);

      const editArgs = getIssueEditArgs();
      expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe(label);
      expect(editArgs).not.toContain('--add-label');
    }
  );

  it('filters branches to only shipper-prefixed names for deletion', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
      ]),
      prJson: JSON.stringify([
        { number: 42, headRefName: 'shipper/18-add-reset' },
        { number: 43, headRefName: '18-some-branch' },
      ]),
      timelineByStage: { planned: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
    });

    await resetCommand('18', { force: true, to: 'planned' });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', '--delete', 'shipper/18-add-reset'],
      expect.any(Object)
    );

    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (entry: unknown[]) =>
        entry[0] === 'git' &&
        (entry[1] as string[]).includes('--delete') &&
        (entry[1] as string[]).includes('18-some-branch')
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('does not match PRs where the issue number is only a substring', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      prJson: JSON.stringify([
        { number: 50, headRefName: 'shipper/180-other-feature' },
        { number: 51, headRefName: 'shipper/118-another' },
        { number: 52, headRefName: 'shipper/18-correct-match' },
      ]),
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
    });

    await resetCommand('18', { force: true, to: 'implemented' });

    const closeCalls = mockGh.mock.calls.filter(
      ([args]) => (args as string[])[0] === 'pr' && (args as string[])[1] === 'close'
    );
    expect(closeCalls).toHaveLength(1);
    const firstCloseCall = closeCalls[0]?.[0] as string[] | undefined;
    expect(firstCloseCall).toBeDefined();
    expect(firstCloseCall?.[2]).toBe('52');
  });

  it('posts a generalized reset notice for implemented targets', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
    });

    await resetCommand('18', { force: true, to: 'implemented' });

    const body = getIssueCommentBody();
    expect(body).toContain('This issue has been reset to `shipper:implemented`.');
    expect(body).toContain('Artifacts after this stage have been cleaned up.');
    expect(body).not.toContain('suggestion for the next grooming attempt');
  });

  it('adds the existing issue-body caveat when resetting to new', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed']),
      commentIds: '601\n',
    });

    await resetCommand('18', { force: true, to: 'new' });

    const body = getIssueCommentBody();
    expect(body).toContain('This issue has been reset to `shipper:new`.');
    expect(body).toContain('Artifacts after this stage have been cleaned up.');
    expect(body).toContain('suggestion for the next grooming attempt');
  });
});
