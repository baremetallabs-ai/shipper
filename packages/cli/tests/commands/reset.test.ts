import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeCore } from '../_harness/fake-core.js';
import { resetCommand } from '../../src/commands/reset.js';

type ErrnoError = Error & { code?: string };
type FakeCore = ReturnType<typeof createFakeCore>;

const issueNumber = '18';
const repo = 'owner/repo';

const { mockConfirm, mockPromptChoice, mockExecFileSync, mockReaddirSync, mockExistsSync } =
  vi.hoisted(() => ({
    mockConfirm: vi.fn<(message?: string) => Promise<boolean>>(),
    mockPromptChoice: vi.fn<(message: string, choices: string[]) => Promise<string>>(),
    mockExecFileSync:
      vi.fn<(command: string, args: string[], options?: Record<string, unknown>) => string>(),
    mockReaddirSync:
      vi.fn<
        (
          path: string,
          options?: { withFileTypes?: boolean }
        ) => Array<{ name: string; isDirectory: () => boolean }>
      >(),
    mockExistsSync: vi.fn<(path: string) => boolean>(),
  }));

vi.mock('../../src/lib/confirm.js', () => ({
  confirm: mockConfirm,
  promptChoice: mockPromptChoice,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (command: string, args: string[], options?: Record<string, unknown>) =>
      mockExecFileSync(command, args, options),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (filePath: string) => mockExistsSync(filePath),
    readdirSync: (filePath: string, options?: { withFileTypes?: boolean }) =>
      mockReaddirSync(filePath, options),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => '/tmp/home',
  };
});

function issueViewPayload(state: string, labels: string[]): string {
  return JSON.stringify({
    number: Number(issueNumber),
    state,
    labels: labels.map((name) => ({ name })),
  });
}

function commentsWithDatesPayload(entries: Array<{ id: number; created_at: string }>): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

function localWorktreePath(name: string): string {
  return `/tmp/home/.shipper/worktrees/${name}`;
}

describe('resetCommand', () => {
  let fake: FakeCore | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let closedPrs: string[];
  let deletedComments: string[];
  let deletedBranches: string[];
  let deletedLocalBranches: string[];

  const setupResetState = (
    options: {
      issueState?: string;
      labels?: string[];
      timelineByLabel?: Record<string, string>;
      commentIds?: number[];
      commentsWithDates?: Array<{ id: number; created_at: string }>;
      prs?: Array<{ number: number; headRefName: string }>;
      branchPrsByHead?: Record<string, Array<{ number: number; headRefName: string }>>;
      closePrErrors?: Record<string, string>;
      deleteCommentErrors?: Record<string, string>;
      deleteBranchErrors?: Record<string, string>;
      remoteBranchesOutput?: string;
      localBranchesOutput?: string;
      currentBranch?: string;
      showCurrentError?: string;
      worktreeEntries?: Array<{ name: string; isDirectory?: boolean }>;
      worktreeReadError?: ErrnoError;
      existingWorktrees?: string[];
      gitCommonDir?: string;
    } = {}
  ): void => {
    fake = createFakeCore();
    fake.install();
    const labels = options.labels ?? ['shipper:planned'];
    const issueState = options.issueState ?? 'OPEN';
    const timelineByLabel = options.timelineByLabel ?? {};
    const prs = options.prs ?? [];
    const branchPrsByHead = options.branchPrsByHead ?? {};
    const closePrErrors = options.closePrErrors ?? {};
    const deleteCommentErrors = options.deleteCommentErrors ?? {};
    const deleteBranchErrors = options.deleteBranchErrors ?? {};
    const existingWorktrees = new Set(options.existingWorktrees ?? []);
    const issueComments = options.commentIds ?? [];
    const issueCommentsWithDates = options.commentsWithDates ?? [];

    fake.setIssue(issueNumber, { labels });
    for (const pr of prs) {
      fake.setPr(String(pr.number), { headRefName: pr.headRefName });
    }

    fake.stubGh((args) => {
      if (args[0] === 'repo' && args[1] === 'view') {
        return { stdout: `${repo}\n`, stderr: '' };
      }

      if (args[0] === 'issue' && args[1] === 'view' && args[2] === issueNumber) {
        return {
          stdout: issueViewPayload(issueState, labels),
          stderr: '',
        };
      }

      if (args[0] === 'issue' && args[1] === 'edit' && args[2] === issueNumber) {
        const issue = fake.state.issues.get(issueNumber);
        if (!issue) {
          throw new Error('missing fake issue');
        }

        const add = (
          args.includes('--add-label') ? (args[args.indexOf('--add-label') + 1] ?? '') : ''
        )
          .split(',')
          .filter(Boolean);
        const remove = (
          args.includes('--remove-label') ? (args[args.indexOf('--remove-label') + 1] ?? '') : ''
        )
          .split(',')
          .filter(Boolean);

        for (const label of add) issue.labels.add(label);
        for (const label of remove) issue.labels.delete(label);
        fake.state.labelTransitions.push({
          target: 'issue',
          number: issueNumber,
          add,
          remove,
        });
        return { stdout: '', stderr: '' };
      }

      if (args[0] === 'api' && typeof args[1] === 'string' && args[1].includes('/timeline')) {
        const jq = args.includes('--jq') ? (args[args.indexOf('--jq') + 1] ?? '') : '';
        const labelMatch = /shipper:[a-z-]+/.exec(jq);
        const label = labelMatch?.[0] ?? '';
        return { stdout: timelineByLabel[label] ?? '', stderr: '' };
      }

      if (
        args[0] === 'api' &&
        typeof args[1] === 'string' &&
        args[1].includes(`/issues/${issueNumber}/comments`) &&
        !args.includes('DELETE')
      ) {
        const jq = args.includes('--jq') ? (args[args.indexOf('--jq') + 1] ?? '') : '';
        if (jq.includes('created_at')) {
          return {
            stdout: commentsWithDatesPayload(issueCommentsWithDates),
            stderr: '',
          };
        }

        return {
          stdout: issueComments.map(String).join('\n'),
          stderr: '',
        };
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        typeof args[3] === 'string' &&
        args[3].includes('/issues/comments/')
      ) {
        const commentId = args[3].split('/').at(-1) ?? '';
        const error = deleteCommentErrors[commentId];
        if (error) {
          throw new Error(error);
        }
        deletedComments.push(commentId);
        return { stdout: '', stderr: '' };
      }

      if (args[0] === 'pr' && args[1] === 'list' && args.includes('--search')) {
        return {
          stdout: JSON.stringify(prs),
          stderr: '',
        };
      }

      if (args[0] === 'pr' && args[1] === 'list' && args.includes('--head')) {
        const head = args.includes('--head') ? (args[args.indexOf('--head') + 1] ?? '') : '';
        return {
          stdout: JSON.stringify(branchPrsByHead[head] ?? []),
          stderr: '',
        };
      }

      if (args[0] === 'pr' && args[1] === 'close' && args[2]) {
        const pr = args[2];
        const error = closePrErrors[pr];
        if (error) {
          throw new Error(error);
        }
        closedPrs.push(pr);
        return { stdout: '', stderr: '' };
      }

      if (
        args[0] === 'api' &&
        args[1] === '-X' &&
        args[2] === 'DELETE' &&
        typeof args[3] === 'string' &&
        args[3].includes('/git/refs/heads/')
      ) {
        const branchName = args[3].split('/heads/')[1] ?? '';
        const error = deleteBranchErrors[branchName];
        if (error) {
          throw new Error(error);
        }
        deletedBranches.push(branchName);
        return { stdout: '', stderr: '' };
      }

      return undefined;
    });

    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command !== 'git') {
        return '';
      }

      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return options.gitCommonDir ?? '/tmp/fake-repo/.git';
      }

      if (args[0] === 'fetch' && args[1] === 'origin') {
        return '';
      }

      if (args[0] === 'branch' && args[1] === '-r') {
        return options.remoteBranchesOutput ?? '';
      }

      if (args[0] === 'branch' && args[1] === '--list') {
        return options.localBranchesOutput ?? '';
      }

      if (args[0] === 'branch' && args[1] === '--show-current') {
        if (options.showCurrentError) {
          throw new Error(options.showCurrentError);
        }
        return options.currentBranch ?? '';
      }

      if (args[0] === 'worktree' && args[1] === 'prune') {
        return '';
      }

      if (args[0] === 'branch' && args[1] === '-D' && args[2]) {
        deletedLocalBranches.push(args[2]);
        return '';
      }

      return '';
    });

    mockReaddirSync.mockImplementation(() => {
      if (options.worktreeReadError) {
        throw options.worktreeReadError;
      }

      return (options.worktreeEntries ?? []).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory ?? true,
      }));
    });

    mockExistsSync.mockImplementation((filePath: string) => existingWorktrees.has(filePath));
  };

  beforeEach(() => {
    process.exitCode = undefined;
    closedPrs = [];
    deletedComments = [];
    deletedBranches = [];
    deletedLocalBranches = [];

    mockConfirm.mockReset();
    mockPromptChoice.mockReset();
    mockExecFileSync.mockReset();
    mockReaddirSync.mockReset();
    mockExistsSync.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockPromptChoice.mockResolvedValue('1');

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fake?.dispose();
    fake = undefined;
  });

  it('throws for invalid issue number', async () => {
    await expect(resetCommand('abc', { force: true })).rejects.toThrow(
      'Error: Please provide a valid issue number.'
    );
    expect(errorSpy).toHaveBeenCalledWith('[shipper] Usage: shipper reset <issue> [--to <stage>]');
  });

  it('rejects partial numeric input like 18foo', async () => {
    await expect(resetCommand('18foo', { force: true })).rejects.toThrow(
      'Error: Please provide a valid issue number.'
    );
    expect(errorSpy).toHaveBeenCalledWith('[shipper] Usage: shipper reset <issue> [--to <stage>]');
  });

  it('throws for closed issues', async () => {
    setupResetState({ issueState: 'CLOSED', labels: ['shipper:groomed'] });

    await expect(resetCommand(issueNumber, { force: true })).rejects.toThrow(
      'Issue #18 is closed. Reset only works on open issues.'
    );
  });

  it('strips # prefix from the issue number', async () => {
    setupResetState({ labels: ['shipper:new', 'shipper:groomed'], commentIds: [101] });

    await resetCommand('#18', { force: true, to: 'new' });

    expect(closedPrs).toHaveLength(0);
    expect(fake.state.postedComments.at(-1)?.body).toContain('shipper:new');
  });

  it('blocks reset when shipper:locked is present and the lock is not stale', async () => {
    setupResetState({
      labels: ['shipper:groomed', 'shipper:locked'],
      timelineByLabel: {
        'shipper:locked': `${new Date().toISOString()}\n`,
      },
    });

    await expect(resetCommand(issueNumber, { force: false, to: 'new' })).rejects.toThrow(
      'Issue #18 is locked by another shipper instance. Use --force to override.'
    );
  });

  it('allows reset with --force when shipper:locked is present', async () => {
    setupResetState({
      labels: ['shipper:groomed', 'shipper:locked'],
      commentIds: [101],
    });

    await resetCommand(issueNumber, { force: true, to: 'new' });

    expect(
      warnSpy.mock.calls.some(([message]) => String(message).includes('locked by another shipper'))
    ).toBe(false);
  });

  it('allows reset when lock is stale', async () => {
    setupResetState({
      labels: ['shipper:groomed', 'shipper:locked'],
      timelineByLabel: {
        'shipper:locked': '2024-01-15T12:00:00Z\n',
      },
      commentIds: [101],
    });

    await resetCommand(issueNumber, { force: false, to: 'new' });

    expect(fake.state.postedComments.at(-1)?.body).toContain('shipper:new');
  });

  it('skips target selection when --to is provided', async () => {
    setupResetState({
      labels: ['shipper:planned'],
      timelineByLabel: { 'shipper:groomed': '2024-01-15T12:00:00Z\n' },
      commentsWithDates: [{ id: 201, created_at: '2024-01-15T12:00:01Z' }],
    });

    await resetCommand(issueNumber, { force: true, to: 'groomed' });

    expect(mockPromptChoice).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[shipper]   Target: shipper:groomed');
  });

  it('accepts full shipper label names with --to', async () => {
    setupResetState({
      labels: ['shipper:new', 'shipper:groomed', 'shipper:designed', 'shipper:planned'],
      timelineByLabel: { 'shipper:designed': '2024-01-15T12:00:00Z\n' },
      commentsWithDates: [{ id: 202, created_at: '2024-01-15T12:00:01Z' }],
    });

    await resetCommand(issueNumber, { force: true, to: 'shipper:designed' });

    expect(logSpy).toHaveBeenCalledWith('[shipper]   Target: shipper:designed');
  });

  it('shows interactive targets for a planned issue', async () => {
    setupResetState({ labels: ['shipper:planned'], commentIds: [101] });
    mockPromptChoice.mockResolvedValue('2');

    await resetCommand(issueNumber, { force: true });

    expect(logSpy).toHaveBeenCalledWith('\n[shipper] Reset targets:');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   1) new');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   2) groomed');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   3) designed');
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-3]: ', ['1', '2', '3']);
    expect(logSpy).toHaveBeenCalledWith('[shipper]   Target: shipper:groomed');
  });

  it('includes implemented as a valid target when PR-stage labels are present', async () => {
    setupResetState({
      labels: ['shipper:implemented', 'shipper:pr-open'],
      timelineByLabel: { 'shipper:implemented': '2024-01-15T12:00:00Z\n' },
    });
    mockPromptChoice.mockResolvedValue('5');

    await resetCommand(issueNumber, { force: true });

    expect(logSpy).toHaveBeenCalledWith('[shipper]   5) implemented');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   Target: shipper:implemented');
  });

  it('skips both prompts when --to and --force are provided together', async () => {
    setupResetState({
      labels: ['shipper:planned'],
      timelineByLabel: { 'shipper:groomed': '2024-01-15T12:00:00Z\n' },
      commentsWithDates: [],
    });

    await resetCommand(issueNumber, { force: true, to: 'groomed' });

    expect(mockPromptChoice).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('prompts for confirmation without --force and cancels cleanly', async () => {
    setupResetState({ labels: ['shipper:planned'], commentIds: [101] });
    mockConfirm.mockResolvedValue(false);

    await resetCommand(issueNumber, { force: false });

    expect(mockConfirm).toHaveBeenCalledWith('Proceed? (y/N): ');
    expect(logSpy).toHaveBeenCalledWith('[shipper] Reset cancelled.');
    expect(fake.state.postedComments).toHaveLength(0);
  });

  it('prints the dry-run summary before confirmation', async () => {
    const wtName = 'fake-repo--wt--shipper-18-add-reset';
    setupResetState({
      labels: ['shipper:new', 'shipper:groomed', 'shipper:designed', 'shipper:planned'],
      timelineByLabel: { 'shipper:groomed': '2024-01-15T12:00:00Z\n' },
      commentsWithDates: [
        { id: 101, created_at: '2024-01-15T12:01:01Z' },
        { id: 102, created_at: '2024-01-15T12:01:02Z' },
      ],
      prs: [{ number: 42, headRefName: 'shipper/18-add-reset' }],
      remoteBranchesOutput: '  origin/shipper/18-add-reset\n',
      localBranchesOutput: '  shipper/18-add-reset\n',
      currentBranch: 'main',
      worktreeEntries: [{ name: wtName }],
    });
    mockPromptChoice.mockResolvedValue('2');
    mockConfirm.mockResolvedValue(false);

    await resetCommand(issueNumber, { force: false });

    expect(logSpy).toHaveBeenCalledWith('\n[shipper] Reset summary for issue #18:');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   Target: shipper:groomed');
    expect(logSpy).toHaveBeenCalledWith(
      '[shipper]   Labels to remove: shipper:designed, shipper:planned'
    );
    expect(logSpy).toHaveBeenCalledWith('[shipper]   Comments to delete: 2');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   PRs to close: #42');
    expect(logSpy).toHaveBeenCalledWith(
      '[shipper]   Remote branches to delete: shipper/18-add-reset'
    );
    expect(logSpy).toHaveBeenCalledWith(
      `[shipper]   Local worktrees to remove: ${localWorktreePath(wtName)}`
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[shipper]   Local branches to delete: shipper/18-add-reset'
    );
  });

  it('prints succeeded operations without calling process.exit', async () => {
    setupResetState({
      labels: ['shipper:planned'],
      commentIds: [101],
      prs: [{ number: 42, headRefName: 'shipper/18-add-reset' }],
      remoteBranchesOutput: '  origin/shipper/18-add-reset\n',
    });

    await resetCommand(issueNumber, { force: true, to: 'new' });

    expect(logSpy).toHaveBeenCalledWith('\n[shipper] Reset complete for issue #18:');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   ✓ Close PR #42');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   ✓ Delete remote branch shipper/18-add-reset');
    expect(logSpy).toHaveBeenCalledWith('[shipper]   ✓ Post reset notice comment');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints skipped operations without retry guidance when no failures occurred', async () => {
    setupResetState({
      labels: ['shipper:planned'],
      commentIds: [101],
      prs: [{ number: 42, headRefName: 'shipper/18-add-reset' }],
      remoteBranchesOutput: '  origin/shipper/18-add-reset\n',
      closePrErrors: { '42': 'already closed' },
      deleteBranchErrors: { 'shipper/18-add-reset': 'reference does not exist' },
    });

    await resetCommand(issueNumber, { force: true, to: 'new' });

    expect(logSpy).toHaveBeenCalledWith('[shipper]   — Close PR #42 (already closed)');
    expect(logSpy).toHaveBeenCalledWith(
      '[shipper]   — Delete remote branch shipper/18-add-reset (already deleted)'
    );
    expect(
      logSpy.mock.calls.some(([message]) =>
        String(message).includes(
          'Some operations failed. Re-run the command to retry failed operations.'
        )
      )
    ).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints failures, later operations, retry guidance, and sets process.exitCode on partial failure', async () => {
    setupResetState({
      labels: ['shipper:planned'],
      commentIds: [101],
      prs: [{ number: 42, headRefName: 'shipper/18-add-reset' }],
      remoteBranchesOutput: '  origin/shipper/18-add-reset\n',
      deleteBranchErrors: { 'shipper/18-add-reset': 'network error' },
    });

    await resetCommand(issueNumber, { force: true, to: 'new' });

    expect(logSpy).toHaveBeenCalledWith('[shipper]   ✓ Close PR #42');
    expect(logSpy).toHaveBeenCalledWith(
      '[shipper]   ✗ Delete remote branch shipper/18-add-reset: network error'
    );
    expect(logSpy).toHaveBeenCalledWith('[shipper]   ✓ Delete comment 101');
    expect(logSpy).toHaveBeenCalledWith(
      '\n[shipper] Some operations failed. Re-run the command to retry failed operations.'
    );
    expect(process.exitCode).toBe(1);
  });

  it('does not print retry guidance for reruns with only succeeded and skipped operations', async () => {
    setupResetState({
      labels: ['shipper:implemented', 'shipper:pr-open'],
      timelineByLabel: { 'shipper:implemented': '2024-01-15T12:00:00Z\n' },
      prs: [{ number: 42, headRefName: 'shipper/18-add-reset' }],
      closePrErrors: { '42': 'already closed' },
    });

    await resetCommand(issueNumber, { force: true, to: 'implemented' });

    expect(
      logSpy.mock.calls.some(([message]) =>
        String(message).includes(
          'Some operations failed. Re-run the command to retry failed operations.'
        )
      )
    ).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects resetting to the current stage', async () => {
    setupResetState({ labels: ['shipper:groomed'] });

    await expect(resetCommand(issueNumber, { force: true, to: 'groomed' })).rejects.toThrow(
      'Error: Issue #18 is already at shipper:groomed. Reset only works backward.'
    );
  });

  it('rejects resetting to a later stage', async () => {
    setupResetState({ labels: ['shipper:groomed'] });

    await expect(resetCommand(issueNumber, { force: true, to: 'designed' })).rejects.toThrow(
      'Error: shipper:designed is ahead of the current stage shipper:groomed. Reset only works backward.'
    );
  });

  it('rejects non-workflow stage names', async () => {
    setupResetState();

    await expect(resetCommand(issueNumber, { force: true, to: 'blocked' })).rejects.toThrow(
      'Error: blocked is not a valid workflow stage. Valid stages: new, groomed, designed, planned, implemented.'
    );
  });

  it('rejects non-workflow shipper labels', async () => {
    setupResetState();

    await expect(resetCommand(issueNumber, { force: true, to: 'shipper:blocked' })).rejects.toThrow(
      'Error: shipper:blocked is not a valid workflow stage. Valid stages: new, groomed, designed, planned, implemented.'
    );
  });

  it('rejects invalid stage names', async () => {
    setupResetState();

    await expect(resetCommand(issueNumber, { force: true, to: 'banana' })).rejects.toThrow(
      'Error: banana is not a valid stage name. Valid stages: new, groomed, designed, planned, implemented.'
    );
  });

  describe('shipper:failed-only issues', () => {
    it('allows resetting a failed-only issue to a requested stage', async () => {
      setupResetState({ labels: ['shipper:failed'] });

      await resetCommand(issueNumber, { force: true, to: 'planned' });

      expect(logSpy).toHaveBeenCalledWith('[shipper]   Target: shipper:planned');
      expect(fake.state.labelTransitions).toEqual(
        expect.arrayContaining([
          {
            target: 'issue',
            number: issueNumber,
            add: ['shipper:planned'],
            remove: ['shipper:failed'],
          },
        ])
      );
    });

    it('lists all workflow stages in interactive mode for a failed-only issue', async () => {
      setupResetState({ labels: ['shipper:failed'] });

      await resetCommand(issueNumber, { force: true });

      expect(logSpy).toHaveBeenCalledWith('[shipper]   1) new');
      expect(logSpy).toHaveBeenCalledWith('[shipper]   2) groomed');
      expect(logSpy).toHaveBeenCalledWith('[shipper]   3) designed');
      expect(logSpy).toHaveBeenCalledWith('[shipper]   4) planned');
      expect(logSpy).toHaveBeenCalledWith('[shipper]   5) implemented');
      expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-5]: ', ['1', '2', '3', '4', '5']);
    });

    it('still rejects forward resets when shipper:failed is paired with a workflow stage', async () => {
      setupResetState({ labels: ['shipper:planned', 'shipper:failed'] });

      await expect(resetCommand(issueNumber, { force: true, to: 'implemented' })).rejects.toThrow(
        'Error: shipper:implemented is ahead of the current stage shipper:planned. Reset only works backward.'
      );
    });
  });
});
