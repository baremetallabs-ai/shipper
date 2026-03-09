import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const readFileMock = vi.fn();
const fetchIssueMock = vi.fn();
const fetchPRMock = vi.fn();
const resolveAgentMock = vi.fn().mockReturnValue('claude');

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: (...args: unknown[]) => readFileMock(...args) };
});

vi.mock('../../src/lib/github.js', () => ({
  fetchIssue: (...args: unknown[]) => fetchIssueMock(...args),
  fetchPR: (...args: unknown[]) => fetchPRMock(...args),
}));

vi.mock('../../src/lib/settings.js', () => ({
  resolveAgent: (...args: unknown[]) => resolveAgentMock(...args),
}));

vi.mock('../../src/lib/prompts.js', () => ({
  agentPrompts: {
    claude: { 'test.md': '---\ncmd: claude\n---\n\nbundled body' },
  },
}));

function mockSpawnResult(opts: { code?: number; error?: Error } = {}): void {
  const { code = 0, error } = opts;
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stderr?: EventEmitter;
      stdout?: EventEmitter;
    };
    globalThis.queueMicrotask(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      child.emit('close', code);
    });
    return child;
  });
}

const { runPrompt } = await import('../../src/lib/prompt-runner.js');

afterEach(() => {
  vi.clearAllMocks();
  resolveAgentMock.mockReturnValue('claude');
  fetchIssueMock.mockResolvedValue('issue body');
  fetchPRMock.mockResolvedValue('pr body');
});

describe('runPrompt', () => {
  it('uses --append-system-prompt for claude prompts', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('prompt body');
  });

  it('passes the prompt body as a positional argument for codex', async () => {
    resolveAgentMock.mockReturnValue('codex');
    readFileMock.mockResolvedValueOnce(['---', 'cmd: codex', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--append-system-prompt');
    expect(args).toContain('prompt body');
  });

  it('reads the prompt from the resolved agent subdirectory', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult();

    await runPrompt('test', {});

    expect(readFileMock).toHaveBeenCalledWith(
      path.resolve('.shipper', 'prompts', 'claude', 'test.md'),
      'utf-8'
    );
  });

  it('replaces {{BASE_BRANCH}} when provided', async () => {
    readFileMock.mockResolvedValueOnce(
      ['---', 'cmd: claude', '---', '', 'git rebase origin/{{BASE_BRANCH}}'].join('\n')
    );
    mockSpawnResult();

    await runPrompt('test', { baseBranch: 'develop' });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('git rebase origin/develop');
  });

  it('appends fetched issue and PR text when requested by frontmatter', async () => {
    readFileMock.mockResolvedValueOnce(
      [
        '---',
        'cmd: claude',
        'append-issue: true',
        'append-pr: true',
        '---',
        '',
        'prompt body',
      ].join('\n')
    );
    fetchIssueMock.mockResolvedValueOnce('issue details');
    fetchPRMock.mockResolvedValueOnce('pr details');
    mockSpawnResult();

    await runPrompt('test', { issueRef: '42', prRef: '5' });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('issue details\n\n---\n\npr details');
  });

  it('returns 1 when the resolved agent does not match frontmatter', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: codex', '---', '', 'prompt body'].join('\n'));

    await expect(runPrompt('test', {})).resolves.toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses the bundled fallback when no local file exists', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
    mockSpawnResult();

    await expect(runPrompt('test', {})).resolves.toBe(0);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('bundled body');
  });

  it('returns 1 when neither a local nor bundled prompt exists', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(runPrompt('missing', {})).resolves.toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns 1 when spawning the agent fails', async () => {
    readFileMock.mockResolvedValueOnce(['---', 'cmd: claude', '---', '', 'prompt body'].join('\n'));
    mockSpawnResult({ error: new Error('spawn failed') });

    await expect(runPrompt('test', {})).resolves.toBe(1);
  });
});
