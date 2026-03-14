import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ghMock = vi.fn();

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => ghMock(...args),
}));

const {
  PROTOCOL_INPUT_DIR,
  PROTOCOL_OUTPUT_DIR,
  executeTransition,
  formatCorrectionMessage,
  handleAgentCrash,
  postComment,
  processResult,
  scrubOutputDir,
  setupProtocolDirs,
  writeContextFile,
} = await import('../../src/lib/output-protocol.js');

describe('output protocol helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    ghMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-output-protocol-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates protocol directories idempotently', async () => {
    await setupProtocolDirs(tempDir);
    await setupProtocolDirs(tempDir);

    await expect(stat(path.join(tempDir, PROTOCOL_INPUT_DIR))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(stat(path.join(tempDir, PROTOCOL_OUTPUT_DIR))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it('scrubs output files while preserving .gitkeep', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    await mkdir(path.join(outputDir, 'replies'), { recursive: true });
    await writeFile(path.join(outputDir, '.gitkeep'), '', 'utf-8');
    await writeFile(path.join(outputDir, 'result.json'), '{}', 'utf-8');
    await writeFile(path.join(outputDir, 'replies', '1.md'), 'reply', 'utf-8');

    await scrubOutputDir(tempDir);

    await expect(readdir(outputDir)).resolves.toEqual(['.gitkeep']);
  });

  it('writes context files under the protocol input directory', async () => {
    await writeContextFile(tempDir, 'issue-248.md', 'issue snapshot');

    await expect(
      readFile(path.join(tempDir, PROTOCOL_INPUT_DIR, 'issue-248.md'), 'utf-8')
    ).resolves.toBe('issue snapshot');
  });

  it('rejects context file paths that escape the protocol input directory', async () => {
    await expect(writeContextFile(tempDir, '../issue-248.md', 'issue snapshot')).rejects.toThrow(
      `context filename must stay within ${path.join(tempDir, PROTOCOL_INPUT_DIR)}`
    );
  });

  it('posts label transitions with gh issue edit', async () => {
    await executeTransition('owner/repo', '248', {
      add: ['shipper:planned'],
      remove: ['shipper:designed'],
    });

    expect(ghMock).toHaveBeenCalledWith([
      'issue',
      'edit',
      '248',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:planned',
      '--remove-label',
      'shipper:designed',
    ]);
  });

  it('skips gh issue edit when the transition is a no-op', async () => {
    await executeTransition('owner/repo', '248', { add: [], remove: [] });

    expect(ghMock).not.toHaveBeenCalled();
  });

  it('posts comments from body files', async () => {
    await postComment('owner/repo', '248', '/tmp/comment.md');

    expect(ghMock).toHaveBeenCalledWith([
      'issue',
      'comment',
      '248',
      '-R',
      'owner/repo',
      '--body-file',
      '/tmp/comment.md',
    ]);
  });

  it('processes a result by posting the comment before changing labels', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify({
        verdict: 'accept',
        comment: '.shipper/output/comment-248.md',
      }),
      'utf-8'
    );
    await writeFile(path.join(outputDir, 'comment-248.md'), 'summary', 'utf-8');

    await expect(
      processResult({
        repo: 'owner/repo',
        issueNumber: '248',
        stage: 'plan',
        cwd: tempDir,
      })
    ).resolves.toEqual({
      verdict: 'accept',
      comment: '.shipper/output/comment-248.md',
    });

    expect(ghMock).toHaveBeenNthCalledWith(1, [
      'issue',
      'comment',
      '248',
      '-R',
      'owner/repo',
      '--body-file',
      path.join(tempDir, '.shipper/output/comment-248.md'),
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'issue',
      'edit',
      '248',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:planned',
      '--remove-label',
      'shipper:designed',
    ]);
  });

  it('does not attempt gh operations when result.json is missing', async () => {
    await expect(
      processResult({
        repo: 'owner/repo',
        issueNumber: '248',
        stage: 'design',
        cwd: tempDir,
      })
    ).rejects.toThrowError(
      `Missing result.json at ${path.join(tempDir, PROTOCOL_OUTPUT_DIR, 'result.json')}`
    );

    expect(ghMock).not.toHaveBeenCalled();
  });

  it('rejects comment paths that escape the protocol output directory', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify({
        verdict: 'accept',
        comment: '.shipper/input/comment-248.md',
      }),
      'utf-8'
    );

    await expect(
      processResult({
        repo: 'owner/repo',
        issueNumber: '248',
        stage: 'design',
        cwd: tempDir,
      })
    ).rejects.toThrowError(
      `Invalid result.json at ${path.join(outputDir, 'result.json')}:\n- 'comment' must be a relative path under .shipper/output`
    );

    expect(ghMock).not.toHaveBeenCalled();
  });

  it('formats correction messages with every validation error', () => {
    expect(
      formatCorrectionMessage([
        "missing required field 'comment'",
        "'verdict' must be one of: accept, reject, fail (got 'approved')",
      ])
    ).toBe(
      "Your previous output was invalid. Fix the following and produce a valid .shipper/output/result.json:\n- missing required field 'comment'\n- 'verdict' must be one of: accept, reject, fail (got 'approved')"
    );
  });

  it('posts a crash comment without attempting a label transition', async () => {
    await handleAgentCrash('owner/repo', '248', 'implement', 'Agent timed out after 30 minutes.');

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(ghMock).toHaveBeenCalledWith([
      'issue',
      'comment',
      '248',
      '-R',
      'owner/repo',
      '--body',
      [
        '## Agent Failure',
        '',
        'The `implement` agent run exited without producing a valid `.shipper/output/result.json`.',
        '',
        'Agent timed out after 30 minutes.',
      ].join('\n'),
    ]);
  });
});
