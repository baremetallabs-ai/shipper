import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';

const spawnSyncMock = vi.fn();
const readFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));
vi.mock('node:fs', () => ({ readFileSync: (...args: unknown[]) => readFileSyncMock(...args) }));
vi.mock('../../src/lib/github.js', () => ({
  fetchIssue: vi.fn(),
  fetchPR: vi.fn(),
}));

const resolveAgentMock = vi.fn().mockReturnValue('claude');
vi.mock('../../src/lib/settings.js', () => ({
  resolveAgent: (...args: unknown[]) => resolveAgentMock(...args),
}));

import { runPrompt } from '../../src/lib/prompt-runner.js';

afterEach(() => {
  vi.clearAllMocks();
  resolveAgentMock.mockReturnValue('claude');
});

describe('runPrompt agent-specific arg construction', () => {
  it('uses --append-system-prompt for cmd: claude', () => {
    const prompt = ['---', 'cmd: claude', '---', '', 'prompt body'].join('\n');
    readFileSyncMock.mockReturnValueOnce(prompt);
    spawnSyncMock.mockReturnValueOnce({ status: 0, error: null });

    runPrompt('test', {});

    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('prompt body');
  });

  it('passes prompt body as positional arg for cmd: codex', () => {
    resolveAgentMock.mockReturnValue('codex');
    const prompt = ['---', 'cmd: codex', '---', '', 'prompt body'].join('\n');
    readFileSyncMock.mockReturnValueOnce(prompt);
    spawnSyncMock.mockReturnValueOnce({ status: 0, error: null });

    runPrompt('test', {});

    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--append-system-prompt');
    expect(args).toContain('prompt body');
  });
});

describe('runPrompt agent resolution', () => {
  it('reads prompt from agent subdirectory', () => {
    const prompt = ['---', 'cmd: claude', '---', '', 'prompt body'].join('\n');
    readFileSyncMock.mockReturnValueOnce(prompt);
    spawnSyncMock.mockReturnValueOnce({ status: 0, error: null });

    runPrompt('test', {});

    const expectedPath = path.resolve('.shipper', 'prompts', 'claude', 'test.md');
    expect(readFileSyncMock).toHaveBeenCalledWith(expectedPath, 'utf-8');
  });

  it('spawns the resolved agent', () => {
    resolveAgentMock.mockReturnValue('codex');
    const prompt = ['---', 'cmd: codex', '---', '', 'prompt body'].join('\n');
    readFileSyncMock.mockReturnValueOnce(prompt);
    spawnSyncMock.mockReturnValueOnce({ status: 0, error: null });

    runPrompt('test', {});

    expect(spawnSyncMock.mock.calls[0][0]).toBe('codex');
  });

  it('passes step name to resolveAgent', () => {
    const prompt = ['---', 'cmd: claude', '---', '', 'prompt body'].join('\n');
    readFileSyncMock.mockReturnValueOnce(prompt);
    spawnSyncMock.mockReturnValueOnce({ status: 0, error: null });

    runPrompt('implement', {});

    expect(resolveAgentMock).toHaveBeenCalledWith('implement');
  });
});

describe('runPrompt agent/frontmatter mismatch', () => {
  it('returns 1 when resolved agent differs from frontmatter cmd', () => {
    const prompt = ['---', 'cmd: codex', '---', '', 'prompt body'].join('\n');
    readFileSyncMock.mockReturnValueOnce(prompt);

    const result = runPrompt('test', {});

    expect(result).toBe(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe('runPrompt baseBranch replacement', () => {
  it('replaces {{BASE_BRANCH}} in prompt body when baseBranch is provided', () => {
    const prompt = [
      '---',
      'cmd: claude',
      '---',
      '',
      'git rebase origin/{{BASE_BRANCH}}',
      'git diff origin/{{BASE_BRANCH}}...HEAD',
    ].join('\n');
    readFileSyncMock.mockReturnValueOnce(prompt);
    spawnSyncMock.mockReturnValueOnce({ status: 0, error: null });

    runPrompt('test', { baseBranch: 'develop' });

    const appendSystemPromptArg = spawnSyncMock.mock.calls[0][1].find(
      (_: string, i: number, arr: string[]) => arr[i - 1] === '--append-system-prompt'
    );
    expect(appendSystemPromptArg).toContain('origin/develop');
    expect(appendSystemPromptArg).not.toContain('{{BASE_BRANCH}}');
  });

  it('leaves {{BASE_BRANCH}} as-is when baseBranch is not provided', () => {
    const prompt = ['---', 'cmd: claude', '---', '', 'git rebase origin/{{BASE_BRANCH}}'].join(
      '\n'
    );
    readFileSyncMock.mockReturnValueOnce(prompt);
    spawnSyncMock.mockReturnValueOnce({ status: 0, error: null });

    runPrompt('test', {});

    const appendSystemPromptArg = spawnSyncMock.mock.calls[0][1].find(
      (_: string, i: number, arr: string[]) => arr[i - 1] === '--append-system-prompt'
    );
    expect(appendSystemPromptArg).toContain('{{BASE_BRANCH}}');
  });
});
