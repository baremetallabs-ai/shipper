import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExtractFinalMessage,
  mockFetchIssue,
  mockFindLatestSessionMeta,
  mockGh,
  mockIsLockStale,
  mockListIssues,
  mockReadFile,
  mockReadResultFile,
  mockReleaseLock,
  mockResolveSessionRepo,
  mockSpawnShipper,
  mockTryResolvePr,
} = vi.hoisted(() => ({
  mockExtractFinalMessage: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockFindLatestSessionMeta: vi.fn(),
  mockGh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  mockIsLockStale: vi.fn(),
  mockListIssues: vi.fn(),
  mockReadFile: vi.fn(),
  mockReadResultFile: vi.fn(),
  mockReleaseLock: vi.fn(),
  mockResolveSessionRepo: vi.fn(),
  mockSpawnShipper: vi.fn(),
  mockTryResolvePr: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: mockReadFile,
  };
});

vi.mock('@dnsquared/shipper-core', async () => {
  const actual =
    await vi.importActual<typeof import('@dnsquared/shipper-core')>('@dnsquared/shipper-core');
  return {
    ...actual,
    extractFinalMessage: mockExtractFinalMessage,
    fetchIssue: mockFetchIssue,
    findLatestSessionMeta: mockFindLatestSessionMeta,
    getSettings: () => ({ agentTimeoutMinutes: 60 }),
    gh: (args: string[]) => mockGh(args),
    isLockStale: mockIsLockStale,
    listIssues: mockListIssues,
    readResultFile: mockReadResultFile,
    releaseIssueLock: mockReleaseLock,
    resolveSessionRepo: mockResolveSessionRepo,
    tryResolvePrForIssue: mockTryResolvePr,
  };
});

vi.mock('../src/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../src/helpers.js')>('../src/helpers.js');
  return {
    ...actual,
    spawnShipper: mockSpawnShipper,
  };
});

import { registerTools } from '../src/tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function collectTools(): (name: string) => Handler {
  const handlers = new Map<string, Handler>();
  const mockServer = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  registerTools(mockServer as unknown as Parameters<typeof registerTools>[0], 'owner/repo');
  return (name) => {
    const handler = handlers.get(name);
    if (!handler) {
      throw new Error(`Tool ${name} was not registered`);
    }
    return handler;
  };
}

function issueLabelsResponse(...labels: string[]): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({
      number: 42,
      state: 'OPEN',
      labels: labels.map((name) => ({ name })),
    }),
    stderr: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSessionRepo.mockResolvedValue({ repo: 'owner/repo', repoSlug: 'owner-repo' });
  mockReadFile.mockResolvedValue('## Implementation Summary\n\nBlocked on upstream dependency.\n');
});

describe('shipper_list_issues', () => {
  it('groups issues by stage and renders blocked/failed separately', async () => {
    mockGh.mockResolvedValue({
      stdout: JSON.stringify([
        { number: 1, title: 'Groomed one', labels: [{ name: 'shipper:groomed' }] },
        {
          number: 2,
          title: 'Blocked one',
          labels: [{ name: 'shipper:planned' }, { name: 'shipper:blocked' }],
        },
        { number: 3, title: 'Failed one', labels: [{ name: 'shipper:failed' }] },
      ]),
      stderr: '',
    });

    const getTool = collectTools();
    const result = await getTool('shipper_list_issues')({});
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Groomed one');
    expect(text).toContain('Blocked');
    expect(text).toContain('#2 Blocked one [planned]');
    expect(text).toContain('Failed');
    expect(text).toContain('#3 Failed one');
  });
});

describe('shipper_get_issue', () => {
  it('appends linked PR info when present', async () => {
    mockFetchIssue.mockResolvedValue('<issue number="7">...</issue>');
    mockTryResolvePr.mockResolvedValue('99');

    const getTool = collectTools();
    const result = await getTool('shipper_get_issue')({ issue: 7 });

    expect(result.content[0]?.text).toContain('<issue number="7">');
    expect(result.content[0]?.text).toContain('<linked-pr number="99"/>');
  });
});

describe('shipper_unlock', () => {
  it('releases a specific issue lock', async () => {
    mockReleaseLock.mockResolvedValue(undefined);

    const getTool = collectTools();
    const result = await getTool('shipper_unlock')({ issue: 10 });

    expect(mockReleaseLock).toHaveBeenCalledWith('owner/repo', '10');
    expect(result.content[0]?.text).toContain('Released lock on #10');
  });
});

describe('shipper_advance', () => {
  it('returns structured accept output with PR URL, final message, and session log', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:implemented'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '{"type":"assistant"}',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'implement',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/advance.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Implemented the requested change.');
    mockTryResolvePr.mockResolvedValue('17');

    const getTool = collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });
    const text = result.content[0]?.text ?? '';

    expect(mockSpawnShipper).toHaveBeenCalledWith(['next', '42', '--mode', 'headless'], {
      timeoutMs: 60 * 60 * 1000,
    });
    expect(result.isError).toBeUndefined();
    expect(text).toContain('Stage: shipper:planned -> shipper:implemented (accept)');
    expect(text).toContain('PR: https://github.com/owner/repo/pull/17');
    expect(text).toContain('Implemented the requested change.');
    expect(text).toContain('Session log: /tmp/advance.jsonl');
    expect(text).not.toContain('--- stdout ---');
    expect(text).not.toContain('"type":"assistant"');
  });

  it('keeps structured reject output while preserving isError on non-zero exits', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:designed'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'rejected',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'implement',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 1,
      logFile: '/tmp/reject.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Rejected the current implementation approach.');

    const getTool = collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Stage: shipper:planned -> shipper:designed (reject)'
    );
    expect(result.content[0]?.text).toContain('Rejected the current implementation approach.');
  });

  it('returns structured fail output when the stage records shipper:failed', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:failed'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'stage failed',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'implement',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 1,
      logFile: '/tmp/fail.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Marked the issue as failed.');

    const getTool = collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Stage: shipper:planned -> shipper:failed (fail)');
    expect(result.content[0]?.text).toContain('Session log: /tmp/fail.jsonl');
  });

  it('falls back to a focused failure summary when no verdict can be recovered', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 1,
      stdout: '{"type":"assistant"}',
      stderr: 'agent crashed',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'implement',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 1,
      logFile: '/tmp/crash.jsonl',
    });

    const getTool = collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[exit 1] shipper next 42 --mode headless');
    expect(result.content[0]?.text).toContain('agent crashed');
    expect(result.content[0]?.text).not.toContain('"type":"assistant"');
  });

  it('returns a no-op advance result when the issue is already ready', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:ready'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:ready'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });

    const getTool = collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(mockFindLatestSessionMeta).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Stage: shipper:ready -> shipper:ready (noop)');
    expect(result.content[0]?.text).toContain(
      'No final message was captured in this run. See session log for details.'
    );
  });

  it('refuses to advance a shipper:new issue', async () => {
    mockGh.mockResolvedValue(issueLabelsResponse('shipper:new'));

    const getTool = collectTools();
    const result = await getTool('shipper_advance')({ issue: 42 });

    expect(mockSpawnShipper).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('interactively');
  });
});

describe('shipper_create_issue', () => {
  it('returns the created issue payload, final message, and session log without transcript content', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '{"type":"response_item"}',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'codex',
      model: 'gpt-5',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/create.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(
      'Created issue: https://github.com/owner/repo/issues/55\nSummary follows.'
    );
    mockGh.mockResolvedValue({
      stdout: JSON.stringify({
        number: 55,
        title: 'Improve MCP tool output summaries',
        url: 'https://github.com/owner/repo/issues/55',
      }),
      stderr: '',
    });

    const getTool = collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Improve MCP output' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Created issue: #55 Improve MCP tool output summaries');
    expect(text).toContain('URL: https://github.com/owner/repo/issues/55');
    expect(text).toContain('Created issue: https://github.com/owner/repo/issues/55');
    expect(text).toContain('Session log: /tmp/create.jsonl');
    expect(text).not.toContain('--- stdout ---');
    expect(text).not.toContain('response_item');
    expect(text.length).toBeLessThan(8192);
  });

  it('prefers the last matching issue URL from the current repo in the final message', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'codex',
      model: 'gpt-5',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/create-last-url.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(
      [
        'Related: https://github.com/owner/repo/issues/11',
        'Cross-repo: https://github.com/other/repo/issues/12',
        'Created issue: https://github.com/owner/repo/issues/55',
      ].join('\n')
    );
    mockGh.mockResolvedValue({
      stdout: JSON.stringify({
        number: 55,
        title: 'Prefer the created issue URL',
        url: 'https://github.com/owner/repo/issues/55',
      }),
      stderr: '',
    });

    const getTool = collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Prefer last URL' });

    expect(mockGh).toHaveBeenCalledTimes(1);
    expect(mockGh).toHaveBeenCalledWith([
      'issue',
      'view',
      '55',
      '-R',
      'owner/repo',
      '--json',
      'number,title,url',
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Created issue: #55 Prefer the created issue URL');
  });

  it('uses the exact missing-final-message fallback while still returning structured payload', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/no-message.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(undefined);
    mockGh
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 56,
            title: 'Fallback issue',
            url: 'https://github.com/owner/repo/issues/56',
            createdAt: '2026-04-21T00:00:02.000Z',
          },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 56,
          title: 'Fallback issue',
          url: 'https://github.com/owner/repo/issues/56',
        }),
        stderr: '',
      });

    const getTool = collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Fallback path' });

    expect(result.content[0]?.text).toContain('Created issue: #56 Fallback issue');
    expect(result.content[0]?.text).toContain(
      'No final message was captured in this run. See session log for details.'
    );
  });

  it('falls back to issue-list recovery when the final message has no issue URL', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/fallback.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Created the issue and wrote a summary.');
    mockGh
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 57,
            title: 'Recovered via fallback',
            url: 'https://github.com/owner/repo/issues/57',
            createdAt: '2026-04-21T00:00:03.000Z',
          },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 57,
          title: 'Recovered via fallback',
          url: 'https://github.com/owner/repo/issues/57',
        }),
        stderr: '',
      });

    const getTool = collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Fallback' });

    expect(result.content[0]?.text).toContain('Created issue: #57 Recovered via fallback');
    expect(result.content[0]?.text).toContain('Created the issue and wrote a summary.');
  });

  it('requires an unambiguous fallback issue candidate before recovering the payload', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/ambiguous.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('Created the issue and wrote a summary.');
    mockGh.mockResolvedValue({
      stdout: JSON.stringify([
        {
          number: 57,
          title: 'First candidate',
          url: 'https://github.com/owner/repo/issues/57',
          createdAt: '2026-04-21T00:00:03.000Z',
        },
        {
          number: 58,
          title: 'Second candidate',
          url: 'https://github.com/owner/repo/issues/58',
          createdAt: '2026-04-21T00:00:04.000Z',
        },
      ]),
      stderr: '',
    });

    const getTool = collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'Fallback ambiguity' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Unable to recover created issue details from post-run metadata.'
    );
    expect(result.content[0]?.text).toContain('Created the issue and wrote a summary.');
    expect(result.content[0]?.text).toContain('Session log: /tmp/ambiguous.jsonl');
  });

  it('keeps the final message and session log when issue recovery gh calls fail', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: 'unlinked',
      stage: 'new',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'codex',
      model: 'gpt-5',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/create-gh-failure.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(
      'Created issue: https://github.com/owner/repo/issues/55\nSummary follows.'
    );
    mockGh.mockRejectedValue(new Error('gh issue view failed'));

    const getTool = collectTools();
    const result = await getTool('shipper_create_issue')({ request: 'GH recovery failure' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Unable to recover created issue details from post-run metadata.'
    );
    expect(result.content[0]?.text).toContain(
      'Created issue: https://github.com/owner/repo/issues/55'
    );
    expect(result.content[0]?.text).toContain('Session log: /tmp/create-gh-failure.jsonl');
  });
});

describe('shipper_unblock', () => {
  it('returns the unblock verdict, reason, final message, and session log from result.json', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'unblock',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/unblock.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('The issue is now unblocked.');
    mockReadResultFile.mockResolvedValue({
      verdict: 'accept',
      comment: '.shipper/output/comment-42.md',
    });
    mockReadFile.mockResolvedValue(
      '## Implementation Summary\n\nDependency landed upstream.\n\n## Agent Feedback\nIgnored.'
    );

    const getTool = collectTools();
    const result = await getTool('shipper_unblock')({ issue: 42 });

    expect(result.content[0]?.text).toContain('Verdict: unblocked');
    expect(result.content[0]?.text).toContain('Reason: Dependency landed upstream.');
    expect(result.content[0]?.text).toContain('The issue is now unblocked.');
    expect(result.content[0]?.text).toContain('Session log: /tmp/unblock.jsonl');
  });

  it('falls back to label-diff recovery when result.json is unavailable', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'unblock',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 0,
      logFile: '/tmp/still-blocked.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue(undefined);
    mockReadResultFile.mockRejectedValue(new Error('Missing result.json'));

    const getTool = collectTools();
    const result = await getTool('shipper_unblock')({ issue: 42 });

    expect(result.content[0]?.text).toContain('Verdict: still-blocked');
    expect(result.content[0]?.text).toContain('Reason: <not recorded>');
    expect(result.content[0]?.text).toContain(
      'No final message was captured in this run. See session log for details.'
    );
  });

  it('reports a failed unblock when the stage records fail', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'))
      .mockResolvedValueOnce(
        issueLabelsResponse('shipper:planned', 'shipper:blocked', 'shipper:failed')
      );
    mockSpawnShipper.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'failed',
      timedOut: false,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'unblock',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: 1,
      logFile: '/tmp/unblock-failed.jsonl',
    });
    mockExtractFinalMessage.mockResolvedValue('The blocker could not be cleared.');
    mockReadResultFile.mockResolvedValue({
      verdict: 'fail',
      comment: '.shipper/output/comment-42.md',
    });
    mockReadFile.mockResolvedValue(
      '## Implementation Summary\n\nStill blocked by upstream failure.\n'
    );

    const getTool = collectTools();
    const result = await getTool('shipper_unblock')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Verdict: failed');
    expect(result.content[0]?.text).toContain('Reason: Still blocked by upstream failure.');
  });

  it('returns a focused failure summary when no verdict can be recovered', async () => {
    mockGh
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned', 'shipper:blocked'))
      .mockResolvedValueOnce(issueLabelsResponse('shipper:planned'));
    mockSpawnShipper.mockResolvedValue({
      exitCode: -1,
      stdout: '{"type":"assistant"}',
      stderr: 'timed out after waiting',
      timedOut: true,
    });
    mockFindLatestSessionMeta.mockResolvedValue({
      issue: '42',
      stage: 'unblock',
      timestamp: '2026-04-21T00:00:00.000Z',
      agent: 'claude',
      model: 'sonnet',
      repo: 'owner/repo',
      exitCode: -1,
      logFile: '/tmp/unblock-timeout.jsonl',
    });
    mockReadResultFile.mockRejectedValue(new Error('Missing result.json'));

    const getTool = collectTools();
    const result = await getTool('shipper_unblock')({ issue: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[timed out] shipper unblock 42 --mode headless');
    expect(result.content[0]?.text).toContain('timed out after waiting');
    expect(result.content[0]?.text).not.toContain('"type":"assistant"');
  });
});

describe('shipper_merge', () => {
  it('keeps the raw formatter behavior unchanged', async () => {
    mockSpawnShipper.mockResolvedValue({
      exitCode: 0,
      stdout: 'merged one PR',
      stderr: '',
      timedOut: false,
    });

    const getTool = collectTools();
    const result = await getTool('shipper_merge')({});

    expect(result.content[0]?.text).toContain('[exit 0] shipper merge --once');
    expect(result.content[0]?.text).toContain('--- stdout ---');
    expect(result.content[0]?.text).toContain('merged one PR');
  });
});
