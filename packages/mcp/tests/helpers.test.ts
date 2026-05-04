import { describe, it, expect } from 'vitest';
import {
  formatAdvanceResult,
  formatCreateIssueResult,
  formatResetPreview,
  formatResetResult,
  formatSpawnResult,
  formatToolError,
  formatUnblockResult,
} from '../src/helpers.js';

describe('formatToolError', () => {
  it('returns isError with Error message', () => {
    const result = formatToolError(new Error('boom'));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('boom');
  });

  it('handles non-Error inputs', () => {
    const result = formatToolError('just a string');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('just a string');
  });
});

describe('formatSpawnResult', () => {
  it('formats a successful run without isError', () => {
    const result = formatSpawnResult(
      { exitCode: 0, stdout: 'all good\n', stderr: '', timedOut: false },
      'shipper merge --once'
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('[exit 0] shipper merge --once');
    expect(result.content[0]?.text).toContain('all good');
  });

  it('flags non-zero exit as an error', () => {
    const result = formatSpawnResult(
      { exitCode: 1, stdout: '', stderr: 'bad thing', timedOut: false },
      'shipper next 42 --mode headless'
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[exit 1]');
    expect(result.content[0]?.text).toContain('bad thing');
  });

  it('flags a timeout as an error', () => {
    const result = formatSpawnResult(
      { exitCode: -1, stdout: 'partial', stderr: '', timedOut: true },
      'shipper ship 1 --mode headless'
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[timed out]');
  });

  it('formats an inner hook timeout as a completed non-zero result', () => {
    const result = formatSpawnResult(
      {
        exitCode: 1,
        stdout: '',
        stderr: 'Worktree setup hook timed out after 1 minute',
        timedOut: false,
      },
      'shipper next 42 --mode headless'
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[exit 1]');
    expect(result.content[0]?.text).not.toContain('[timed out]');
    expect(result.content[0]?.text).toContain('Worktree setup hook timed out after 1 minute');
  });
});

describe('tool-specific result formatters', () => {
  it('formats create-issue success with structured payload, final message, and session log', () => {
    const result = formatCreateIssueResult(
      { exitCode: 0, stdout: 'ignored transcript', stderr: '', timedOut: false },
      {
        issueNumber: 42,
        title: 'Improve MCP results',
        url: 'https://github.com/owner/repo/issues/42',
      },
      {
        command: 'shipper new <request> --mode headless',
        finalMessage: 'Created issue #42 and verified the labels.',
        sessionLogPath: '/tmp/session.jsonl',
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Created issue: #42 Improve MCP results');
    expect(result.content[0]?.text).toContain('URL: https://github.com/owner/repo/issues/42');
    expect(result.content[0]?.text).toContain('Created issue #42 and verified the labels.');
    expect(result.content[0]?.text).toContain('Session log: /tmp/session.jsonl');
    expect(result.content[0]?.text).not.toContain('ignored transcript');
  });

  it('renders the missing-final-message fallback line verbatim', () => {
    const result = formatAdvanceResult(
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },
      { from: 'shipper:planned', to: 'shipper:implemented', verdict: 'accept' },
      {
        command: 'shipper next 42 --mode headless',
        sessionLogPath: '/tmp/advance.jsonl',
      }
    );

    expect(result.content[0]?.text).toContain(
      'No final message was captured in this run. See session log for details.'
    );
  });

  it('formats failure summaries with a bounded stderr tail and session-log fallback', () => {
    const result = formatUnblockResult(
      {
        exitCode: 1,
        stdout: 'full transcript',
        stderr: 'line 1\nline 2\nfatal detail',
        timedOut: false,
      },
      undefined,
      {
        command: 'shipper unblock 42 --mode headless',
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[exit 1] shipper unblock 42 --mode headless');
    expect(result.content[0]?.text).toContain('--- stderr (tail) ---');
    expect(result.content[0]?.text).toContain('fatal detail');
    expect(result.content[0]?.text).toContain('Session log: <not found>');
    expect(result.content[0]?.text).not.toContain('full transcript');
  });

  it('forces isError when structured payload recovery fails after an exit-0 run', () => {
    const result = formatCreateIssueResult(
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },
      undefined,
      {
        command: 'shipper new <request> --mode headless',
        finalMessage: 'Created issue draft and printed the summary.',
        sessionLogPath: '/tmp/create.jsonl',
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Unable to recover created issue details from post-run metadata.'
    );
    expect(result.content[0]?.text).toContain('Created issue draft and printed the summary.');
    expect(result.content[0]?.text).toContain('Session log: /tmp/create.jsonl');
  });

  it('renders session-log-missing markers on structured success paths', () => {
    const result = formatUnblockResult(
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },
      { verdict: 'still-blocked', reason: 'Waiting on upstream dependency.' },
      {
        command: 'shipper unblock 42 --mode headless',
        finalMessage: 'The issue remains blocked.',
      }
    );

    expect(result.content[0]?.text).toContain('Verdict: still-blocked');
    expect(result.content[0]?.text).toContain('Reason: Waiting on upstream dependency.');
    expect(result.content[0]?.text).toContain('Session log: <not found>');
  });

  it('keeps isError true for structured advance payloads recovered from non-zero exits', () => {
    const result = formatAdvanceResult(
      { exitCode: 1, stdout: '', stderr: 'rejecting', timedOut: false },
      {
        from: 'shipper:planned',
        to: 'shipper:designed',
        verdict: 'reject',
        prUrl: 'https://github.com/owner/repo/pull/7',
      },
      {
        command: 'shipper next 42 --mode headless',
        finalMessage: 'Rejected the implementation step.',
        sessionLogPath: '/tmp/reject.jsonl',
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Stage: shipper:planned -> shipper:designed (reject)'
    );
    expect(result.content[0]?.text).toContain('PR: https://github.com/owner/repo/pull/7');
    expect(result.content[0]?.text).toContain('Rejected the implementation step.');
  });
});

describe('reset formatters', () => {
  it('formats a dry-run preview with concrete artifacts and an explicit no-op marker', () => {
    const text = formatResetPreview(42, {
      labelsToRemove: ['shipper:planned', 'shipper:failed'],
      addTarget: true,
      targetStage: 'groomed',
      targetLabel: 'shipper:groomed',
      commentIds: [101, 102],
      prs: [{ number: 7, headRefName: 'shipper/42-reset' }],
      branchesToDelete: ['shipper/42-reset'],
      localBranches: ['shipper/42-reset'],
      localWorktrees: ['/tmp/worktrees/repo--wt--shipper-42-reset'],
    });

    expect(text).toContain('Reset preview for issue #42:');
    expect(text).toContain('Labels to remove: shipper:planned, shipper:failed');
    expect(text).toContain('Label to add: shipper:groomed');
    expect(text).toContain('Comments to delete: 101, 102');
    expect(text).toContain('PRs to close: #7 (shipper/42-reset)');
    expect(text).toContain('Remote branches to delete: shipper/42-reset');
    expect(text).toContain('Local branches to delete: shipper/42-reset');
    expect(text).toContain('Local worktrees to remove: /tmp/worktrees/repo--wt--shipper-42-reset');
    expect(text).toContain('Dry run only; no changes made.');
  });

  it('formats reset operation results with succeeded, skipped, and failed reasons', () => {
    const text = formatResetResult(42, {
      operations: [
        { description: 'Remove local worktree /tmp/wt', status: 'succeeded' },
        {
          description: 'Delete local branch shipper/42-reset',
          status: 'skipped',
          reason: 'already deleted',
        },
        {
          description: 'Post reset notice comment',
          status: 'failed',
          reason: 'GitHub API error',
        },
      ],
      hasFailures: true,
    });

    expect(text).toContain('Reset results for issue #42:');
    expect(text).toContain('succeeded: Remove local worktree /tmp/wt');
    expect(text).toContain('skipped: Delete local branch shipper/42-reset (already deleted)');
    expect(text).toContain('failed: Post reset notice comment (GitHub API error)');
  });
});
