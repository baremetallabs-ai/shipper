import { beforeEach, describe, expect, it, vi } from 'vitest';

type ErrnoError = Error & { code?: string };

const {
  mockConfirm,
  mockPromptChoice,
  mockGetRepoNwo,
  mockGetRepoRoot,
  mockExecFileSync,
  mockGh,
  mockIsLockStale,
  mockReaddirSync,
  mockExistsSync,
  mockHomedir,
  mockExecuteReset,
} = vi.hoisted(() => ({
  mockConfirm: vi.fn<(message?: string) => Promise<boolean>>(),
  mockPromptChoice: vi.fn<(message: string, choices: string[]) => Promise<string>>(),
  mockGetRepoNwo: vi.fn(() => 'owner/repo'),
  mockGetRepoRoot: vi.fn(() => Promise.resolve('/tmp/fake-repo')),
  mockExecFileSync: vi.fn<(command: string, args: string[]) => string>(),
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  mockIsLockStale: vi.fn<(repo: string, issue: string) => boolean>(() => true),
  mockReaddirSync: vi.fn<(path: string) => Array<{ name: string; isDirectory: () => boolean }>>(),
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockHomedir: vi.fn(() => '/tmp/home'),
  mockExecuteReset: vi.fn<
    (
      issueNum: number,
      scan: {
        labelsToRemove: string[];
        addTarget: boolean;
        targetStage: string;
        targetLabel: string;
        commentIds: number[];
        prs: Array<{ number: number; headRefName: string }>;
        branchesToDelete: string[];
        localBranches: string[];
        localWorktrees: string[];
      },
      nwo: string,
      options?: { repoRoot?: string }
    ) => Promise<{
      operations: Array<{
        description: string;
        status: 'succeeded' | 'failed' | 'skipped';
        reason?: string;
      }>;
      hasFailures: boolean;
    }>
  >(),
}));

vi.mock('../../src/lib/confirm.js', () => ({
  confirm: mockConfirm,
  promptChoice: mockPromptChoice,
}));

vi.mock('@dnsquared/shipper-core', async () => {
  const { toErrorMessage } = await vi.importActual<
    typeof import('../../../core/src/lib/errors.js')
  >('../../../core/src/lib/errors.js');

  const logger = {
    log: (message: string) => {
      console.log(`[shipper] ${message}`);
    },
    warn: (message: string) => {
      console.warn(`[shipper] ${message}`);
    },
    error: (message: string) => {
      console.error(`[shipper] ${message}`);
    },
  };

  const STAGE_LABEL_NAMES = [
    'shipper:new',
    'shipper:groomed',
    'shipper:designed',
    'shipper:planned',
    'shipper:implemented',
    'shipper:pr-open',
    'shipper:pr-reviewed',
    'shipper:ready',
  ];
  const IMPLEMENTED_LABEL = 'shipper:implemented';
  const BLOCKED_LABEL = 'shipper:blocked';
  const FAILED_LABEL = 'shipper:failed';
  const LOCKED_LABEL = 'shipper:locked';
  const PRIORITY_LABEL_NAMES = ['shipper:priority-high', 'shipper:priority-low'];
  const IMPLEMENTED_STAGE_INDEX = STAGE_LABEL_NAMES.indexOf(IMPLEMENTED_LABEL);
  const RESETTABLE_STAGE_NAMES = STAGE_LABEL_NAMES.slice(0, IMPLEMENTED_STAGE_INDEX + 1).map(
    (label) => label.replace(/^shipper:/, '')
  );
  const POST_IMPLEMENTATION_STAGE_LABELS = STAGE_LABEL_NAMES.slice(IMPLEMENTED_STAGE_INDEX + 1);

  function getStageLabel(stage: string): string {
    return `shipper:${stage}`;
  }

  function getStageIndex(stage: string): number {
    return RESETTABLE_STAGE_NAMES.indexOf(stage);
  }

  function parseStage(input: string): string | null {
    const normalized = input.replace(/^shipper:/, '');
    return RESETTABLE_STAGE_NAMES.includes(normalized) ? normalized : null;
  }

  function getCurrentStage(labels: string[]): { stage: string; hasPrLabels: boolean } {
    const hasPrLabels = labels.some((label) => POST_IMPLEMENTATION_STAGE_LABELS.includes(label));

    if (hasPrLabels) {
      return { stage: 'implemented', hasPrLabels: true };
    }

    for (let index = RESETTABLE_STAGE_NAMES.length - 1; index >= 0; index -= 1) {
      const stage = RESETTABLE_STAGE_NAMES[index];
      if (stage && labels.includes(getStageLabel(stage))) {
        return { stage, hasPrLabels: false };
      }
    }

    return { stage: 'new', hasPrLabels: false };
  }

  function getValidTargets(currentStage: { stage: string; hasPrLabels: boolean }): string[] {
    const targets = RESETTABLE_STAGE_NAMES.slice(0, getStageIndex(currentStage.stage));
    if (currentStage.hasPrLabels) {
      targets.push('implemented');
    }
    return targets;
  }

  function isClean(scan: {
    labelsToRemove: string[];
    addTarget: boolean;
    commentIds: number[];
    prs: unknown[];
    branchesToDelete: string[];
    localBranches: string[];
    localWorktrees: string[];
  }): boolean {
    return (
      scan.labelsToRemove.length === 0 &&
      !scan.addTarget &&
      scan.commentIds.length === 0 &&
      scan.prs.length === 0 &&
      scan.branchesToDelete.length === 0 &&
      scan.localBranches.length === 0 &&
      scan.localWorktrees.length === 0
    );
  }

  async function getStageTimestamp(
    issueNum: number,
    nwo: string,
    stage: string
  ): Promise<string | null> {
    try {
      const { stdout } = await mockGh([
        'api',
        `repos/${nwo}/issues/${issueNum}/timeline`,
        '--paginate',
        '--jq',
        `.[] | select(.event == "labeled" and .label.name? == "${getStageLabel(stage)}") | .created_at`,
      ]);
      const output = stdout.trim();
      if (!output) {
        return null;
      }

      const timestamps = output.split('\n').filter((line) => line.trim());
      return timestamps.at(-1) ?? null;
    } catch {
      return null;
    }
  }

  async function scanArtifacts(
    issueNum: number,
    nwo: string,
    targetStage: string,
    labels: string[],
    options: { repoRoot?: string; repoName: string }
  ) {
    const targetIndex = getStageIndex(targetStage);
    const targetLabel = getStageLabel(targetStage);
    const labelsToRemove = labels.filter((label) => {
      if (PRIORITY_LABEL_NAMES.includes(label)) {
        return false;
      }

      if (targetStage === 'new') {
        return label.startsWith('shipper:') && label !== targetLabel;
      }

      if (POST_IMPLEMENTATION_STAGE_LABELS.includes(label)) {
        return true;
      }

      if (!label.startsWith('shipper:')) {
        return false;
      }

      const labelStage = parseStage(label);
      return labelStage !== null && getStageIndex(labelStage) > targetIndex;
    });

    if (labels.includes(FAILED_LABEL) && !labelsToRemove.includes(FAILED_LABEL)) {
      labelsToRemove.push(FAILED_LABEL);
    }

    const addTarget = !labels.includes(targetLabel);

    let commentIds: number[] = [];
    if (targetStage === 'new') {
      const { stdout } = await mockGh([
        'api',
        `repos/${nwo}/issues/${issueNum}/comments`,
        '--paginate',
        '--jq',
        '.[].id',
      ]);
      commentIds = stdout
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map(Number);
    } else {
      const stageTimestamp = await getStageTimestamp(issueNum, nwo, targetStage);
      if (stageTimestamp) {
        const cutoff = Date.parse(stageTimestamp) + 60_000;
        const { stdout } = await mockGh([
          'api',
          `repos/${nwo}/issues/${issueNum}/comments`,
          '--paginate',
          '--jq',
          '.[] | {id, created_at}',
        ]);

        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const comment = JSON.parse(line) as { id: number; created_at: string };
          if (Date.parse(comment.created_at) > cutoff) {
            commentIds.push(comment.id);
          }
        }
      } else {
        console.warn(
          `Warning: Could not determine when ${targetLabel} was applied. Skipping comment cleanup.`
        );
      }
    }

    const { stdout: prJson } = await mockGh([
      'pr',
      'list',
      '-R',
      nwo,
      '--search',
      String(issueNum),
      '--state',
      'open',
      '--json',
      'number,headRefName',
    ]);
    const allPrs = JSON.parse(prJson) as Array<{ number: number; headRefName: string }>;
    const prs = allPrs.filter(
      (pr) =>
        pr.headRefName === `shipper/${issueNum}` ||
        pr.headRefName.startsWith(`shipper/${issueNum}-`) ||
        pr.headRefName === `${issueNum}` ||
        pr.headRefName.startsWith(`${issueNum}-`)
    );

    const branchesToDelete =
      targetStage === 'implemented'
        ? []
        : prs.map((pr) => pr.headRefName).filter((branchName) => branchName.startsWith('shipper/'));

    let localWorktrees: string[] = [];
    try {
      const entries = mockReaddirSync(`${mockHomedir()}/.shipper/worktrees`);
      localWorktrees = entries
        .filter((entry) => {
          if (!entry.isDirectory()) {
            return false;
          }

          return (
            entry.name === `${options.repoName}--wt--shipper-${issueNum}` ||
            entry.name.startsWith(`${options.repoName}--wt--shipper-${issueNum}-`)
          );
        })
        .map((entry) => `${mockHomedir()}/.shipper/worktrees/${entry.name}`);
    } catch (error) {
      if ((error as ErrnoError).code !== 'ENOENT') {
        console.warn(
          `Warning: Could not scan local worktrees for issue #${issueNum}: ${toErrorMessage(error)}`
        );
      }
    }

    let localBranches: string[] = [];
    if (targetStage !== 'implemented' && options.repoRoot) {
      try {
        const raw = mockExecFileSync('git', [
          'branch',
          '--list',
          `shipper/${issueNum}`,
          `shipper/${issueNum}-*`,
        ]);
        localBranches = raw
          .split('\n')
          .map((line) =>
            line
              .trim()
              .replace(/^[*+]\s*/, '')
              .trim()
          )
          .filter(Boolean);
      } catch (error) {
        console.warn(
          `Warning: Could not scan local branches for issue #${issueNum}: ${toErrorMessage(error)}`
        );
      }

      if (localBranches.length > 0) {
        try {
          const currentBranch = mockExecFileSync('git', ['branch', '--show-current']).trim();
          if (currentBranch && localBranches.includes(currentBranch)) {
            console.warn(
              `Warning: Skipping local branch ${currentBranch} because it is currently checked out.`
            );
            localBranches = localBranches.filter((branchName) => branchName !== currentBranch);
          }
        } catch (error) {
          console.warn(
            `Warning: Could not determine the current branch for issue #${issueNum}: ${toErrorMessage(error)}`
          );
          console.warn(
            'Warning: Skipping local branch deletion because the checked-out branch is unknown.'
          );
          localBranches = [];
        }
      }
    }

    return {
      labelsToRemove,
      addTarget,
      targetStage,
      targetLabel,
      commentIds,
      prs,
      branchesToDelete,
      localBranches,
      localWorktrees,
    };
  }

  async function executeReset(
    issueNum: number,
    scan: Awaited<ReturnType<typeof scanArtifacts>>,
    nwo: string,
    options: { repoRoot?: string } = {}
  ) {
    return mockExecuteReset(issueNum, scan, nwo, options);
  }

  return {
    logger,
    getRepoNwo: () => mockGetRepoNwo(),
    getRepoRoot: () => mockGetRepoRoot(),
    gh: (args: string[]) => mockGh(args),
    isLockStale: (repo: string, issue: string) => mockIsLockStale(repo, issue),
    STAGE_LABEL_NAMES,
    IMPLEMENTED_LABEL,
    BLOCKED_LABEL,
    FAILED_LABEL,
    LOCKED_LABEL,
    getStageLabel,
    getStageIndex,
    parseStage,
    getCurrentStage,
    getValidTargets,
    scanArtifacts,
    isClean,
    executeReset,
    toErrorMessage,
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (command: string, args: string[]) => mockExecFileSync(command, args),
  };
});

vi.mock('node:fs', () => ({
  readdirSync: (path: string) => mockReaddirSync(path),
  existsSync: (path: string) => mockExistsSync(path),
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
vi.spyOn(console, 'warn').mockImplementation(() => {});

const prefixed = (message: string) => `[shipper] ${message}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  mockPromptChoice.mockResolvedValue('1');
  mockIsLockStale.mockReturnValue(true);
  mockGetRepoRoot.mockResolvedValue('/tmp/fake-repo');
  mockReaddirSync.mockReturnValue([]);
  mockExistsSync.mockReturnValue(false);
  mockHomedir.mockReturnValue('/tmp/home');
  mockExecuteReset.mockResolvedValue({
    operations: [],
    hasFailures: false,
  });
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
  worktreeEntries?: Array<{ name: string; isDirectory?: boolean }>;
  worktreeReadError?: ErrnoError;
}) {
  const issueJson = overrides?.issueJson ?? mockIssueView('OPEN', ['shipper:planned']);
  const commentIds = overrides?.commentIds ?? '';
  const prJson = overrides?.prJson ?? '[]';
  const commentsWithDates = overrides?.commentsWithDates ?? '';
  const timelineByStage = overrides?.timelineByStage ?? {};
  const gitCommonDir = overrides?.gitCommonDir ?? '/tmp/fake-repo/.git';
  const localBranchesOutput = overrides?.localBranchesOutput ?? '';
  const currentBranch = overrides?.currentBranch ?? '';

  mockGh.mockImplementation((args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      return Promise.resolve({ stdout: issueJson, stderr: '' });
    }

    if (args[0] === 'api' && typeof args[1] === 'string' && args[1].includes('/timeline')) {
      const jqIndex = args.indexOf('--jq');
      const jq = jqIndex === -1 ? '' : (args[jqIndex + 1] ?? '');
      const match = jq.match(/shipper:([a-z-]+)/);
      const stage = match?.[1];
      return Promise.resolve({ stdout: stage ? (timelineByStage[stage] ?? '') : '', stderr: '' });
    }

    if (
      args[0] === 'api' &&
      typeof args[1] === 'string' &&
      args[1].includes('/comments') &&
      !args.includes('DELETE')
    ) {
      const jqIndex = args.indexOf('--jq');
      const jq = jqIndex === -1 ? '' : (args[jqIndex + 1] ?? '');
      return Promise.resolve({
        stdout: jq.includes('created_at') ? commentsWithDates : commentIds,
        stderr: '',
      });
    }

    if (args[0] === 'pr' && args[1] === 'list') {
      return Promise.resolve({ stdout: prJson, stderr: '' });
    }

    return Promise.resolve({ stdout: '', stderr: '' });
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

  mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd !== 'git') {
      return '';
    }

    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      if (overrides?.gitCommonDirError) {
        throw new Error(overrides.gitCommonDirError);
      }
      return gitCommonDir;
    }

    if (args[0] === 'branch' && args[1] === '--list') {
      return localBranchesOutput;
    }

    if (args[0] === 'branch' && args[1] === '--show-current') {
      if (overrides?.showCurrentError) {
        throw new Error(overrides.showCurrentError);
      }
      return currentBranch;
    }

    return '';
  });
}

function getExecuteResetScan(): {
  labelsToRemove: string[];
  addTarget: boolean;
  targetStage: string;
  targetLabel: string;
  commentIds: number[];
  prs: Array<{ number: number; headRefName: string }>;
  branchesToDelete: string[];
  localBranches: string[];
  localWorktrees: string[];
} {
  const call = mockExecuteReset.mock.calls[0];
  expect(call).toBeDefined();
  return call?.[1] as {
    labelsToRemove: string[];
    addTarget: boolean;
    targetStage: string;
    targetLabel: string;
    commentIds: number[];
    prs: Array<{ number: number; headRefName: string }>;
    branchesToDelete: string[];
    localBranches: string[];
    localWorktrees: string[];
  };
}

function getLocalWorktreePath(name: string): string {
  return `/tmp/home/.shipper/worktrees/${name}`;
}

describe('resetCommand', () => {
  it('exits with error for invalid issue number', async () => {
    await expect(resetCommand('abc', { force: true })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      prefixed('Error: Please provide a valid issue number.')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      prefixed('Usage: shipper reset <issue> [--to <stage>]')
    );
  });

  it('exits with error for closed issues', async () => {
    setupExecMock({ issueJson: mockIssueView('CLOSED', ['shipper:groomed']) });

    await expect(resetCommand('18', { force: true })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      prefixed('Issue #18 is closed. Reset only works on open issues.')
    );
  });

  it('strips # prefix from the issue number', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:new', 'shipper:groomed']),
      commentIds: '101\n',
    });

    await resetCommand('#18', { force: true, to: 'new' });

    expect(mockGh).toHaveBeenCalledWith([
      'issue',
      'view',
      '18',
      '-R',
      'owner/repo',
      '--json',
      'number,state,labels',
    ]);
  });

  it('blocks reset when shipper:locked is present and the lock is not stale', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:locked']),
    });
    mockIsLockStale.mockReturnValue(false);

    await expect(resetCommand('18', { force: false, to: 'new' })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      prefixed('Issue #18 is locked by another shipper instance. Use --force to override.')
    );
  });

  it('skips target selection when --to is provided', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      timelineByStage: { groomed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '{"id":201,"created_at":"2024-01-15T12:00:01Z"}\n',
    });

    await resetCommand('18', { force: true, to: 'groomed' });

    expect(mockPromptChoice).not.toHaveBeenCalled();
    expect(getExecuteResetScan().targetLabel).toBe('shipper:groomed');
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

    expect(getExecuteResetScan().targetLabel).toBe('shipper:designed');
  });

  it('shows interactive targets for a planned issue', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
    });
    mockPromptChoice.mockResolvedValue('2');

    await resetCommand('18', { force: true });

    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('\nReset targets:'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  1) new'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  2) groomed'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  3) designed'));
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-3]: ', ['1', '2', '3']);
    expect(getExecuteResetScan().targetLabel).toBe('shipper:groomed');
  });

  it('includes implemented as a valid target when PR-stage labels are present', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
    });
    mockPromptChoice.mockResolvedValue('5');

    await resetCommand('18', { force: true });

    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  1) new'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  2) groomed'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  3) designed'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  4) planned'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  5) implemented'));
    expect(getExecuteResetScan().targetLabel).toBe('shipper:implemented');
  });

  it('prompts for confirmation without --force and cancels cleanly', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
    });
    mockConfirm.mockResolvedValue(false);

    await resetCommand('18', { force: false });

    expect(mockConfirm).toHaveBeenCalledWith('Proceed? (y/N): ');
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('Reset cancelled.'));
    expect(mockExecuteReset).not.toHaveBeenCalled();
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
      currentBranch: 'main',
      worktreeEntries: [{ name: 'fake-repo--wt--shipper-18-add-reset' }],
    });
    mockPromptChoice.mockResolvedValue('2');
    mockConfirm.mockResolvedValue(false);

    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('\nReset summary for issue #18:'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  Target: shipper:groomed'));
    expect(mockConsoleLog).toHaveBeenCalledWith(
      prefixed('  Labels to remove: shipper:designed, shipper:planned')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  Comments to delete: 2'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  PRs to close: #42'));
    expect(mockConsoleLog).toHaveBeenCalledWith(
      prefixed('  Remote branches to delete: shipper/18-add-reset')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      prefixed(`  Local worktrees to remove: ${localWorktree}`)
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      prefixed('  Local branches to delete: shipper/18-add-reset')
    );
    expect(mockExecuteReset).not.toHaveBeenCalled();
  });

  it('prints succeeded operations without calling process.exit', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
    });
    mockExecuteReset.mockResolvedValue({
      operations: [
        { description: 'Close PR #42', status: 'succeeded' },
        { description: 'Delete remote branch shipper/18-add-reset', status: 'succeeded' },
        { description: 'Post reset notice comment', status: 'succeeded' },
      ],
      hasFailures: false,
    });

    await resetCommand('18', { force: true, to: 'new' });

    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('\nReset complete for issue #18:'));
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  ✓ Close PR #42'));
    expect(mockConsoleLog).toHaveBeenCalledWith(
      prefixed('  ✓ Delete remote branch shipper/18-add-reset')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  ✓ Post reset notice comment'));
    expect(mockConsoleLog).not.toHaveBeenCalledWith(
      prefixed('Some operations failed. Re-run the command to retry failed operations.')
    );
    expect(_mockExit).not.toHaveBeenCalled();
  });

  it('prints skipped operations without retry guidance when no failures occurred', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
    });
    mockExecuteReset.mockResolvedValue({
      operations: [
        {
          description: 'Close PR #42',
          status: 'skipped',
          reason: 'already closed',
        },
        {
          description: 'Delete remote branch shipper/18-add-reset',
          status: 'skipped',
          reason: 'already deleted',
        },
      ],
      hasFailures: false,
    });

    await resetCommand('18', { force: true, to: 'new' });

    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  — Close PR #42 (already closed)'));
    expect(mockConsoleLog).toHaveBeenCalledWith(
      prefixed('  — Delete remote branch shipper/18-add-reset (already deleted)')
    );
    expect(mockConsoleLog).not.toHaveBeenCalledWith(
      prefixed('Some operations failed. Re-run the command to retry failed operations.')
    );
    expect(_mockExit).not.toHaveBeenCalled();
  });

  it('prints failures, later operations, retry guidance, and exits non-zero on partial failure', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
    });
    mockExecuteReset.mockResolvedValue({
      operations: [
        { description: 'Close PR #42', status: 'succeeded' },
        {
          description: 'Delete remote branch shipper/18-add-reset',
          status: 'failed',
          reason: 'network error',
        },
        { description: 'Delete comment 101', status: 'succeeded' },
      ],
      hasFailures: true,
    });

    await expect(resetCommand('18', { force: true, to: 'new' })).rejects.toThrow('process.exit');

    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  ✓ Close PR #42'));
    expect(mockConsoleLog).toHaveBeenCalledWith(
      prefixed('  ✗ Delete remote branch shipper/18-add-reset: network error')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(prefixed('  ✓ Delete comment 101'));
    expect(mockConsoleLog).toHaveBeenCalledWith(
      prefixed('\nSome operations failed. Re-run the command to retry failed operations.')
    );
    expect(_mockExit).toHaveBeenCalledWith(1);
  });

  it('does not print retry guidance for reruns with only succeeded and skipped operations', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
    });
    mockExecuteReset.mockResolvedValue({
      operations: [
        {
          description: 'Close PR #42',
          status: 'skipped',
          reason: 'already closed',
        },
        {
          description: 'Delete remote branch shipper/18-add-reset',
          status: 'skipped',
          reason: 'already deleted',
        },
        { description: 'Post reset notice comment', status: 'succeeded' },
      ],
      hasFailures: false,
    });

    await resetCommand('18', { force: true, to: 'implemented' });

    expect(mockConsoleLog).not.toHaveBeenCalledWith(
      prefixed('Some operations failed. Re-run the command to retry failed operations.')
    );
    expect(_mockExit).not.toHaveBeenCalled();
  });
});
