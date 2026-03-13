import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ghMock = vi.fn();
const fetchIssueMock = vi.fn();
const fetchPRMock = vi.fn();
const runPromptMock = vi.fn();
const processResultMock = vi.fn();

class MockPostflightError extends Error {}

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => ghMock(...args),
}));

vi.mock('../../src/lib/github.js', () => ({
  fetchIssue: (...args: unknown[]) => fetchIssueMock(...args),
  fetchPR: (...args: unknown[]) => fetchPRMock(...args),
}));

vi.mock('../../src/lib/prompt-runner.js', () => ({
  runPrompt: (...args: unknown[]) => runPromptMock(...args),
}));

vi.mock('../../src/lib/postflight.js', () => ({
  processResult: (...args: unknown[]) => processResultMock(...args),
  PostflightError: MockPostflightError,
}));

const { MissingResultError } = await import('../../src/lib/result-schema.js');
const { runStageWithProtocol } = await import('../../src/lib/stage-runner.js');

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'shipper-stage-runner-'));
  await mkdir(path.join(cwd, '.shipper', 'input'), { recursive: true });
  await mkdir(path.join(cwd, '.shipper', 'output'), { recursive: true });
  ghMock.mockReset();
  fetchIssueMock.mockReset();
  fetchPRMock.mockReset();
  runPromptMock.mockReset();
  processResultMock.mockReset();

  fetchIssueMock.mockResolvedValue('<issue>snapshot</issue>');
  fetchPRMock.mockResolvedValue('<pr>snapshot</pr>');
  ghMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'diff') {
      return { stdout: 'diff --git a/file.ts b/file.ts\n', stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls/19/files') {
      return { stdout: '[{"filename":"src/file.ts"}]', stderr: '' };
    }
    if (args[0] === 'api' && args[1] === '/user') {
      return { stdout: 'reviewer\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runStageWithProtocol', () => {
  it('scrubs output and leaves only the active stage manifest in input for design', async () => {
    await writeFile(path.join(cwd, '.shipper', 'input', 'stale.txt'), 'old\n', 'utf-8');
    await writeFile(path.join(cwd, '.shipper', 'output', 'stale.txt'), 'old\n', 'utf-8');
    runPromptMock.mockResolvedValue(0);
    processResultMock.mockResolvedValue(undefined);

    await expect(
      runStageWithProtocol('design', {
        repo: 'owner/repo',
        issueRef: '248',
        cwd,
        promptOpts: { repo: 'owner/repo', issueRef: '248' },
      })
    ).resolves.toBe(0);

    expect(await readdir(path.join(cwd, '.shipper', 'input'))).toEqual(['issue-248.md']);
    expect(await readFile(path.join(cwd, '.shipper', 'input', 'issue-248.md'), 'utf-8')).toContain(
      '<issue>snapshot</issue>'
    );
    expect(await readdir(path.join(cwd, '.shipper', 'output'))).toEqual([]);
  });

  it('writes the pr_review manifest files only', async () => {
    runPromptMock.mockResolvedValue(0);
    processResultMock.mockResolvedValue(undefined);

    await runStageWithProtocol('pr_review', {
      repo: 'owner/repo',
      issueRef: '248',
      prRef: '19',
      cwd,
      promptOpts: { repo: 'owner/repo', issueRef: '248', prRef: '19' },
    });

    expect((await readdir(path.join(cwd, '.shipper', 'input'))).sort()).toEqual([
      'issue-248.md',
      'pr-19.md',
      'pr-diff-19.patch',
      'pr-files-19.json',
      'viewer-login.txt',
    ]);
  });

  it('re-invokes once with an appended correction message when result output is invalid', async () => {
    runPromptMock.mockResolvedValueOnce(9).mockResolvedValueOnce(0);
    processResultMock
      .mockRejectedValueOnce(new MissingResultError('Missing result.json'))
      .mockResolvedValueOnce(undefined);

    await expect(
      runStageWithProtocol('design', {
        repo: 'owner/repo',
        issueRef: '248',
        cwd,
        promptOpts: { repo: 'owner/repo', issueRef: '248', userInput: 'Existing context' },
      })
    ).resolves.toBe(0);

    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(runPromptMock.mock.calls[1][1].userInput).toContain('Existing context');
    expect(runPromptMock.mock.calls[1][1].userInput).toContain(
      'did not produce a valid .shipper/output/result.json'
    );
  });

  it('posts a retryable failure comment and leaves labels unchanged after exhausting retries', async () => {
    runPromptMock.mockResolvedValueOnce(9).mockResolvedValueOnce(7);
    processResultMock
      .mockRejectedValueOnce(new MissingResultError('Missing result.json'))
      .mockRejectedValueOnce(new MissingResultError('Still missing result.json'));

    await expect(
      runStageWithProtocol('design', {
        repo: 'owner/repo',
        issueRef: '248',
        cwd,
        promptOpts: { repo: 'owner/repo', issueRef: '248' },
      })
    ).resolves.toBe(7);

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(ghMock).toHaveBeenCalledWith(
      [
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body',
        expect.stringContaining('eligible for retry'),
      ],
      { cwd }
    );
    expect(
      ghMock.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === 'issue' && args[1] === 'edit'
      )
    ).toBe(false);
  });
});
