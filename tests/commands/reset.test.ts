import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfirm, mockGetRepoNwo, mockExecFileSync } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockGetRepoNwo: vi.fn(() => 'owner/repo'),
  mockExecFileSync: vi.fn(),
}));

vi.mock('../../src/lib/confirm.js', () => ({
  confirm: mockConfirm,
}));

vi.mock('../../src/lib/github.js', () => ({
  getRepoNwo: () => mockGetRepoNwo(),
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

function setupExecMock(overrides?: { issueJson?: string; commentIds?: string; prJson?: string }) {
  const issueJson = overrides?.issueJson ?? mockIssueView('OPEN', ['shipper:groomed']);
  const commentIds = overrides?.commentIds ?? '101\n102\n';
  const prJson = overrides?.prJson ?? '[]';

  mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') return issueJson;
    if (
      args[0] === 'api' &&
      typeof args[1] === 'string' &&
      args[1].includes('/comments') &&
      !args.includes('DELETE')
    )
      return commentIds;
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
        call[0] === 'gh' && (call[1] as string[])[0] === 'pr' && (call[1] as string[])[1] === 'close'
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
});
