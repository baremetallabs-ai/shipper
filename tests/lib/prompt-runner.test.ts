import { describe, it, expect, vi, afterEach } from 'vitest';

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

import { runPrompt } from '../../src/lib/prompt-runner.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPrompt baseBranch replacement', () => {
  it('replaces {{BASE_BRANCH}} in prompt body when baseBranch is provided', () => {
    const prompt = [
      '---',
      'cmd: echo',
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
    const prompt = ['---', 'cmd: echo', '---', '', 'git rebase origin/{{BASE_BRANCH}}'].join('\n');
    readFileSyncMock.mockReturnValueOnce(prompt);
    spawnSyncMock.mockReturnValueOnce({ status: 0, error: null });

    runPrompt('test', {});

    const appendSystemPromptArg = spawnSyncMock.mock.calls[0][1].find(
      (_: string, i: number, arr: string[]) => arr[i - 1] === '--append-system-prompt'
    );
    expect(appendSystemPromptArg).toContain('{{BASE_BRANCH}}');
  });
});
