import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../src/lib/github.js', () => ({
  getRepoNwo: () => mockGetRepoNwo(),
}));

vi.mock('../../src/lib/lock.js', () => ({
  isLockStale: (...args: unknown[]) => mockIsLockStale(...args),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { resetCommand } from '../../src/commands/reset.js';

// Prevent process.exit from actually exiting
const _mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const _mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
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
  timelineOutput?: string;
  commentsWithDates?: string;
}) {
  const issueJson = overrides?.issueJson ?? mockIssueView('OPEN', ['shipper:groomed']);
  const commentIds = overrides?.commentIds ?? '101\n102\n';
  const prJson = overrides?.prJson ?? '[]';
  const timelineOutput = overrides?.timelineOutput ?? '';
  const commentsWithDates = overrides?.commentsWithDates ?? '';

  mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') return issueJson;
    if (args[0] === 'api' && typeof args[1] === 'string' && args[1].includes('/timeline'))
      return timelineOutput;
    if (
      args[0] === 'api' &&
      typeof args[1] === 'string' &&
      args[1].includes('/comments') &&
      !args.includes('DELETE')
    ) {
      // Check if the jq expression requests {id, created_at} (partial mode)
      const jqIdx = args.indexOf('--jq');
      if (jqIdx !== -1 && args[jqIdx + 1]?.includes('created_at')) {
        return commentsWithDates;
      }
      return commentIds;
    }
    if (args[0] === 'pr' && args[1] === 'list') return prJson;
    return '';
  });
}

describe('resetCommand', () => {
  it('exits with error for invalid issue number', async () => {
    await expect(resetCommand('abc', { force: true })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Please provide a valid issue number.');
  });

  it('exits with error for closed issues', async () => {
    setupExecMock({ issueJson: mockIssueView('CLOSED', ['shipper:groomed']) });
    await expect(resetCommand('18', { force: true })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Issue #18 is closed. Reset only works on open issues.'
    );
  });

  it('reports nothing to reset when issue is already clean', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:new']),
      commentIds: '',
      prJson: '[]',
    });
    await resetCommand('18', { force: true });
    expect(mockConsoleLog).toHaveBeenCalledWith('Issue #18 is already clean. Nothing to reset.');
  });

  it('strips # prefix from issue number', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:new']),
      commentIds: '',
      prJson: '[]',
    });
    await resetCommand('#18', { force: true });
    expect(mockConsoleLog).toHaveBeenCalledWith('Issue #18 is already clean. Nothing to reset.');
  });

  it('filters branches to only shipper/-prefixed', async () => {
    setupExecMock({
      prJson: JSON.stringify([
        { number: 42, headRefName: 'shipper/18-add-reset' },
        { number: 43, headRefName: '18-some-branch' },
      ]),
      commentIds: '',
    });

    await resetCommand('18', { force: true });

    // Should delete shipper/18-add-reset branch
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', '--delete', 'shipper/18-add-reset'],
      expect.any(Object)
    );

    // Should NOT delete 18-some-branch
    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'git' &&
        (call[1] as string[]).includes('--delete') &&
        (call[1] as string[]).includes('18-some-branch')
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('does not match PRs where issue number is a substring of branch number', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed']),
      prJson: JSON.stringify([
        { number: 50, headRefName: 'shipper/180-other-feature' },
        { number: 51, headRefName: 'shipper/118-another' },
        { number: 52, headRefName: 'shipper/18-correct-match' },
      ]),
      commentIds: '',
    });

    await resetCommand('18', { force: true });

    // Should close only PR #52 (shipper/18-correct-match)
    const closeCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'pr' &&
        (call[1] as string[])[1] === 'close'
    );
    expect(closeCalls).toHaveLength(1);
    expect((closeCalls[0]![1] as string[])[2]).toBe('52');
  });

  it('rejects partial numeric input like 18foo', async () => {
    await expect(resetCommand('18foo', { force: true })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Please provide a valid issue number.');
  });

  it('skips confirmation with --force flag', async () => {
    setupExecMock();
    await resetCommand('18', { force: true });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('prompts for confirmation without --force', async () => {
    setupExecMock();
    mockConfirm.mockResolvedValue(true);
    await resetCommand('18', { force: false });
    expect(mockConfirm).toHaveBeenCalledWith('Proceed? (y/N): ');
  });

  it('cancels when user declines confirmation', async () => {
    setupExecMock();
    mockConfirm.mockResolvedValue(false);
    await resetCommand('18', { force: false });
    expect(mockConsoleLog).toHaveBeenCalledWith('Reset cancelled.');

    // Should not have called any cleanup commands
    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) => call[0] === 'gh' && (call[1] as string[]).includes('DELETE')
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('prints dry-run summary before confirmation', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:designed']),
      commentIds: '101\n102\n103\n',
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
    });
    mockConfirm.mockResolvedValue(false);
    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith('\nReset summary for issue #18:');
    expect(mockConsoleLog).toHaveBeenCalledWith('  Target: shipper:new');
    expect(mockConsoleLog).toHaveBeenCalledWith(
      '  Labels to remove: shipper:groomed, shipper:designed'
    );
    expect(mockConsoleLog).toHaveBeenCalledWith('  Labels to add: shipper:new');
    expect(mockConsoleLog).toHaveBeenCalledWith('  Comments to delete: 3');
    expect(mockConsoleLog).toHaveBeenCalledWith('  PRs to close: #42');
    expect(mockConsoleLog).toHaveBeenCalledWith('  Branches to delete: shipper/18-add-reset');
  });

  it('executes full cleanup in correct order with --force', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed']),
      commentIds: '101\n',
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
    });

    await resetCommand('18', { force: true });

    // Collect the cleanup calls (after the scan calls)
    const cleanupCalls = mockExecFileSync.mock.calls.filter((call: unknown[]) => {
      const args = call[1] as string[];
      return (
        (call[0] === 'gh' && args[0] === 'pr' && args[1] === 'close') ||
        (call[0] === 'git' && args.includes('--delete')) ||
        (call[0] === 'gh' && args.includes('DELETE')) ||
        (call[0] === 'gh' && args[0] === 'issue' && args[1] === 'edit') ||
        (call[0] === 'gh' && args[0] === 'issue' && args[1] === 'comment')
      );
    });

    // Verify order: close PR, delete branch, delete comment, edit labels, post comment
    expect((cleanupCalls[0]![1] as string[])[1]).toBe('close'); // gh pr close
    expect(cleanupCalls[1]![0]).toBe('git'); // git push --delete
    expect((cleanupCalls[2]![1] as string[]).includes('DELETE')).toBe(true); // gh api DELETE
    // Verify correct comment deletion endpoint (no issue number in path)
    expect((cleanupCalls[2]![1] as string[])[3]).toBe('repos/owner/repo/issues/comments/101');
    expect((cleanupCalls[3]![1] as string[])[1]).toBe('edit'); // gh issue edit
    expect((cleanupCalls[4]![1] as string[])[1]).toBe('comment'); // gh issue comment
  });

  it('removes shipper:locked label during full reset', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:locked']),
      commentIds: '',
      prJson: '[]',
    });

    await resetCommand('18', { force: true });

    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls.length).toBe(1);
    const editArgs = editCalls[0]![1] as string[];
    expect(editArgs).toContain('--remove-label');
    const removeLabelIdx = editArgs.indexOf('--remove-label');
    const labelsStr = editArgs[removeLabelIdx + 1]!;
    expect(labelsStr).toContain('shipper:locked');
    expect(labelsStr).toContain('shipper:groomed');
  });

  // --- New tests for lock-awareness ---

  it('blocks reset when shipper:locked is present and lock is not stale', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:locked']),
    });
    mockIsLockStale.mockReturnValue(false);

    await expect(resetCommand('18', { force: false })).rejects.toThrow('process.exit');
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Issue #18 is locked by another shipper instance. Use --force to override.'
    );
  });

  it('allows reset with --force when shipper:locked is present', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:locked']),
      commentIds: '',
      prJson: '[]',
    });
    mockIsLockStale.mockReturnValue(false);

    // --force should skip lock check entirely
    await resetCommand('18', { force: true });
    expect(mockIsLockStale).not.toHaveBeenCalled();
  });

  it('allows reset when lock is stale', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:groomed', 'shipper:locked']),
      commentIds: '',
      prJson: '[]',
    });
    mockIsLockStale.mockReturnValue(true);
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });
    expect(mockIsLockStale).toHaveBeenCalledWith('18');
    // Should proceed to reset (not exit)
    expect(mockConsoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining('is locked by another shipper instance')
    );
  });

  // --- New tests for mode selection ---

  it('shows choice prompt for PR-stage issue without --force', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      commentIds: '',
      prJson: '[]',
      timelineOutput: '2024-01-15T12:00:00Z\n',
      commentsWithDates: '',
    });
    mockPromptChoice.mockResolvedValue('2');
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-2]: ', ['1', '2']);
  });

  it('shows choice prompt for shipper:pr-reviewed issue', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-reviewed']),
      commentIds: '',
      prJson: '[]',
      timelineOutput: '2024-01-15T12:00:00Z\n',
      commentsWithDates: '',
    });
    mockPromptChoice.mockResolvedValue('2');
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-2]: ', ['1', '2']);
  });

  it('shows choice prompt for shipper:ready issue', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:ready']),
      commentIds: '',
      prJson: '[]',
      timelineOutput: '2024-01-15T12:00:00Z\n',
      commentsWithDates: '',
    });
    mockPromptChoice.mockResolvedValue('2');
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });
    expect(mockPromptChoice).toHaveBeenCalledWith('Select [1-2]: ', ['1', '2']);
  });

  it('does not show choice prompt for non-PR-stage issue', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:planned']),
      commentIds: '101\n',
      prJson: '[]',
    });
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });
    expect(mockPromptChoice).not.toHaveBeenCalled();
    expect(mockConfirm).toHaveBeenCalledWith('Proceed? (y/N): ');
  });

  // --- Partial reset behavior ---

  it('partial reset only removes PR-stage labels and preserves shipper:blocked', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', [
        'shipper:groomed',
        'shipper:designed',
        'shipper:planned',
        'shipper:implemented',
        'shipper:pr-open',
        'shipper:blocked',
      ]),
      prJson: '[]',
      timelineOutput: '2024-01-15T12:00:00Z\n',
      commentsWithDates: '',
    });
    mockPromptChoice.mockResolvedValue('1'); // partial
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });

    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls.length).toBe(1);
    const editArgs = editCalls[0]![1] as string[];
    const removeLabelIdx = editArgs.indexOf('--remove-label');
    const labelsStr = editArgs[removeLabelIdx + 1]!;

    // Only PR-stage labels removed
    expect(labelsStr).toBe('shipper:pr-open');
    // Should NOT remove these:
    expect(labelsStr).not.toContain('shipper:groomed');
    expect(labelsStr).not.toContain('shipper:designed');
    expect(labelsStr).not.toContain('shipper:planned');
    expect(labelsStr).not.toContain('shipper:implemented');
    expect(labelsStr).not.toContain('shipper:blocked');

    // Should NOT add shipper:implemented (already present)
    expect(editArgs).not.toContain('--add-label');
  });

  it('partial reset filters comments by implemented timestamp', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      prJson: '[]',
      timelineOutput: '2024-01-15T12:00:00Z\n',
      commentsWithDates:
        '{"id":201,"created_at":"2024-01-14T00:00:00Z"}\n{"id":202,"created_at":"2024-01-16T00:00:00Z"}\n',
    });
    mockPromptChoice.mockResolvedValue('1'); // partial
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });

    // Should only delete comment 202 (after implemented timestamp)
    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) => call[0] === 'gh' && (call[1] as string[]).includes('DELETE')
    );
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0]![1] as string[])[3]).toBe('repos/owner/repo/issues/comments/202');
  });

  it('partial reset posts correct reset notice', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      prJson: '[]',
      timelineOutput: '2024-01-15T12:00:00Z\n',
      commentsWithDates: '',
    });
    mockPromptChoice.mockResolvedValue('1'); // partial
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });

    const commentCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'comment'
    );
    expect(commentCalls.length).toBe(1);
    const body = (commentCalls[0]![1] as string[])[4];
    expect(body).toContain('shipper:implemented');
    expect(body).toContain('PR artifacts have been cleaned up');
    expect(body).toContain('preserved');
  });

  it('--force on PR-stage issue defaults to full reset with no choice prompt', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      commentIds: '101\n',
      prJson: '[]',
    });

    await resetCommand('18', { force: true });

    // No choice prompt
    expect(mockPromptChoice).not.toHaveBeenCalled();
    // No confirm prompt
    expect(mockConfirm).not.toHaveBeenCalled();

    // Should do full reset — remove shipper:implemented and shipper:pr-open
    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls.length).toBe(1);
    const editArgs = editCalls[0]![1] as string[];
    const removeLabelIdx = editArgs.indexOf('--remove-label');
    const labelsStr = editArgs[removeLabelIdx + 1]!;
    expect(labelsStr).toContain('shipper:implemented');
    expect(labelsStr).toContain('shipper:pr-open');

    // Should add shipper:new
    expect(editArgs).toContain('--add-label');
    const addLabelIdx = editArgs.indexOf('--add-label');
    expect(editArgs[addLabelIdx + 1]).toBe('shipper:new');
  });

  it('partial reset adds shipper:implemented if missing', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:pr-open']),
      prJson: '[]',
      timelineOutput: '2024-01-15T12:00:00Z\n',
      commentsWithDates: '',
    });
    mockPromptChoice.mockResolvedValue('1'); // partial
    mockConfirm.mockResolvedValue(true);

    await resetCommand('18', { force: false });

    const editCalls = mockExecFileSync.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === 'gh' &&
        (call[1] as string[])[0] === 'issue' &&
        (call[1] as string[])[1] === 'edit'
    );
    expect(editCalls.length).toBe(1);
    const editArgs = editCalls[0]![1] as string[];
    expect(editArgs).toContain('--add-label');
    const addLabelIdx = editArgs.indexOf('--add-label');
    expect(editArgs[addLabelIdx + 1]).toBe('shipper:implemented');
  });

  it('dry-run shows target label for partial reset', async () => {
    setupExecMock({
      issueJson: mockIssueView('OPEN', ['shipper:implemented', 'shipper:pr-open']),
      prJson: JSON.stringify([{ number: 42, headRefName: 'shipper/18-add-reset' }]),
      timelineOutput: '2024-01-15T12:00:00Z\n',
      commentsWithDates: '{"id":301,"created_at":"2024-01-16T00:00:00Z"}\n',
    });
    mockPromptChoice.mockResolvedValue('1'); // partial
    mockConfirm.mockResolvedValue(false); // cancel after dry-run

    await resetCommand('18', { force: false });

    expect(mockConsoleLog).toHaveBeenCalledWith('  Target: shipper:implemented');
    expect(mockConsoleLog).toHaveBeenCalledWith('  Labels to remove: shipper:pr-open');
  });
});
