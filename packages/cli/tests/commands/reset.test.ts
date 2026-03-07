import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfirm, mockPromptChoice, mockGetRepoNwo, mockExecFileSync, mockIsLockStale } =
  vi.hoisted(() => ({
    mockConfirm: vi.fn(),
    mockPromptChoice: vi.fn(),
    mockGetRepoNwo: vi.fn(() => 'owner/repo'),
    mockExecFileSync: vi.fn(),
    mockIsLockStale: vi.fn(() => true),
  }));

vi.mock('../../src/lib/confirm.js', () => ({
  confirm: mockConfirm,
  promptChoice: mockPromptChoice,
}));

vi.mock('../../src/lib/repo.js', () => ({
  getRepoNwo: () => mockGetRepoNwo(),
}));

vi.mock('../../src/lib/lock.js', () => ({
  isLockStale: (...args: unknown[]) => mockIsLockStale(...args),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { resetCommand } from '../../src/commands/reset.js';

const _mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const _mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  mockPromptChoice.mockResolvedValue('1');
  mockIsLockStale.mockReturnValue(true);
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
}) {
  const issueJson = overrides?.issueJson ?? mockIssueView('OPEN', ['shipper:planned']);
  const commentIds = overrides?.commentIds ?? '';
  const prJson = overrides?.prJson ?? '[]';
  const commentsWithDates = overrides?.commentsWithDates ?? '';
  const timelineByStage = overrides?.timelineByStage ?? {};

  mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') return issueJson;

    if (args[0] === 'api' && typeof args[1] === 'string' && args[1].includes('/timeline')) {
      const jqIndex = args.indexOf('--jq');
      const jq = jqIndex === -1 ? '' : args[jqIndex + 1]!;
      const match = jq.match(/shipper:([a-z-]+)/);
      return match ? (timelineByStage[match[1]!] ?? '') : '';
    }

    if (
      args[0] === 'api' &&
      typeof args[1] === 'string' &&
      args[1].includes('/comments') &&
      !args.includes('DELETE')
    ) {
      const jqIndex = args.indexOf('--jq');
      const jq = jqIndex === -1 ? '' : args[jqIndex + 1]!;
      return jq.includes('created_at') ? commentsWithDates : commentIds;
    }

    if (args[0] === 'pr' && args[1] === 'list') return prJson;

    return '';
  });
}

function getIssueEditArgs(): string[] {
  const call = mockExecFileSync.mock.calls.find(
    (entry: unknown[]) =>
      entry[0] === 'gh' &&
      (entry[1] as string[])[0] === 'issue' &&
      (entry[1] as string[])[1] === 'edit'
  );

  return call?.[1] as string[];
}

function getIssueCommentBody(): string {
  const call = mockExecFileSync.mock.calls.find(
    (entry: unknown[]) =>
      entry[0] === 'gh' &&
      (entry[1] as string[])[0] === 'issue' &&
      (entry[1] as string[])[1] === 'comment'
  );

  return ((call?.[1] as string[]) ?? [])[4] ?? '';
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
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '18', '--json', 'number,state,labels'],
      expect.any(Object)
    );
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

    expect(mockIsLockStale).toHaveBeenCalledWith('18');
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
    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (entry: unknown[]) => entry[0] === 'gh' && (entry[1] as string[]).includes('DELETE')
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('prints the dry-run summary before confirmation', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
      ]),
      timelineByStage: { groomed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates:
        '{"id":101,"created_at":"2024-01-15T12:00:01Z"}\n{"id":102,"created_at":"2024-01-15T12:00:02Z"}\n',
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
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
    expect(mockConsoleLog).toHaveBeenCalledWith('  Branches to delete: shipper/18-add-reset');
  });

  it('executes cleanup in the expected order', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:groomed',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:locked',
      ]),
      commentIds: '101\n',
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
    });

    await resetCommand('18', { force: true, to: 'new' });

    const cleanupCalls = mockExecFileSync.mock.calls.filter((entry: unknown[]) => {
      const args = entry[1] as string[];
      return (
        (entry[0] === 'gh' && args[0] === 'pr' && args[1] === 'close') ||
        (entry[0] === 'git' && args.includes('--delete')) ||
        (entry[0] === 'gh' && args.includes('DELETE')) ||
        (entry[0] === 'gh' && args[0] === 'issue' && args[1] === 'edit') ||
        (entry[0] === 'gh' && args[0] === 'issue' && args[1] === 'comment')
      );
    });

    expect((cleanupCalls[0]![1] as string[])[1]).toBe('close');
    expect(cleanupCalls[1]![0]).toBe('git');
    expect((cleanupCalls[2]![1] as string[]).includes('DELETE')).toBe(true);
    expect((cleanupCalls[2]![1] as string[])[3]).toBe('repos/owner/repo/issues/comments/101');
    expect((cleanupCalls[3]![1] as string[])[1]).toBe('edit');
    expect((cleanupCalls[4]![1] as string[])[1]).toBe('comment');
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

  it('preserves comments at or before the target stage timestamp minus 60 seconds', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:new',
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
      ]),
      timelineByStage: { designed: '2024-01-15T12:00:00Z\n' },
      commentsWithDates:
        '{"id":301,"created_at":"2024-01-15T11:58:59Z"}\n' +
        '{"id":302,"created_at":"2024-01-15T11:59:00Z"}\n' +
        '{"id":303,"created_at":"2024-01-15T11:59:01Z"}\n',
    });

    await resetCommand('18', { force: true, to: 'designed' });

    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (entry: unknown[]) => entry[0] === 'gh' && (entry[1] as string[]).includes('DELETE')
    );
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0]![1] as string[])[3]).toBe('repos/owner/repo/issues/comments/303');
  });

  it('deletes all comments when resetting to new', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed']),
      commentIds: '401\n402\n403\n',
    });

    await resetCommand('18', { force: true, to: 'new' });

    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (entry: unknown[]) => entry[0] === 'gh' && (entry[1] as string[]).includes('DELETE')
    );
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

  it('matches implemented-target cleanup to the old partial reset behavior', async () => {
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
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
      commentsWithDates:
        '{"id":501,"created_at":"2024-01-15T11:58:59Z"}\n' +
        '{"id":502,"created_at":"2024-01-15T12:00:01Z"}\n',
    });

    await resetCommand('18', { force: true, to: 'implemented' });

    const editArgs = getIssueEditArgs();
    expect(editArgs[editArgs.indexOf('--remove-label') + 1]).toBe('shipper:pr-open');
    expect(editArgs).not.toContain('--add-label');

    const closeCalls = mockExecFileSync.mock.calls.filter(
      (entry: unknown[]) =>
        entry[0] === 'gh' &&
        (entry[1] as string[])[0] === 'pr' &&
        (entry[1] as string[])[1] === 'close'
    );
    expect(closeCalls).toHaveLength(2);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', '--delete', 'shipper/18-add-reset'],
      expect.any(Object)
    );

    const branchDeleteCalls = mockExecFileSync.mock.calls.filter(
      (entry: unknown[]) =>
        entry[0] === 'git' &&
        (entry[1] as string[]).includes('--delete') &&
        (entry[1] as string[]).includes('18-scratch-branch')
    );
    expect(branchDeleteCalls).toHaveLength(0);

    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (entry: unknown[]) => entry[0] === 'gh' && (entry[1] as string[]).includes('DELETE')
    );
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0]![1] as string[])[3]).toBe('repos/owner/repo/issues/comments/502');
  });

  it('filters branches to only shipper-prefixed names for deletion', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      prJson: JSON.stringify([
        { number: 42, headRefName: 'shipper/18-add-reset' },
        { number: 43, headRefName: '18-some-branch' },
      ]),
      timelineByStage: { implemented: '2024-01-15T12:00:00Z\n' },
      commentsWithDates: '',
    });

    await resetCommand('18', { force: true, to: 'implemented' });

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

    const closeCalls = mockExecFileSync.mock.calls.filter(
      (entry: unknown[]) =>
        entry[0] === 'gh' &&
        (entry[1] as string[])[0] === 'pr' &&
        (entry[1] as string[])[1] === 'close'
    );
    expect(closeCalls).toHaveLength(1);
    expect((closeCalls[0]![1] as string[])[2]).toBe('52');
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
