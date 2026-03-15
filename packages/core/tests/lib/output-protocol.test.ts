import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ghMock = vi.fn();

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => ghMock(...args),
}));

const {
  createPrFromSpec,
  PROTOCOL_INPUT_DIR,
  PROTOCOL_OUTPUT_DIR,
  executeTransition,
  formatCorrectionMessage,
  handleAgentCrash,
  postComment,
  postReplies,
  processResult,
  scrubOutputDir,
  submitReviewPayload,
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

  it('posts one review-thread reply per numeric markdown file in stable order', async () => {
    const repliesDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR, 'replies');
    await mkdir(repliesDir, { recursive: true });
    await writeFile(path.join(repliesDir, '102.md'), 'Second reply', 'utf-8');
    await writeFile(path.join(repliesDir, '101.md'), 'First reply', 'utf-8');
    await writeFile(path.join(repliesDir, 'abc.md'), 'skip me', 'utf-8');
    await writeFile(path.join(repliesDir, 'notes.txt'), 'ignore me', 'utf-8');
    await mkdir(path.join(repliesDir, 'nested'));

    await postReplies('owner/repo', '248', tempDir, '.shipper/output/replies');

    expect(ghMock).toHaveBeenNthCalledWith(1, [
      'api',
      'repos/owner/repo/pulls/248/comments/101/replies',
      '--method',
      'POST',
      '-f',
      'body=First reply',
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'api',
      'repos/owner/repo/pulls/248/comments/102/replies',
      '--method',
      'POST',
      '-f',
      'body=Second reply',
    ]);
    expect(ghMock).toHaveBeenCalledTimes(2);
  });

  it('treats an absent replies directory as a no-op', async () => {
    await postReplies('owner/repo', '248', tempDir, '.shipper/output/replies');

    expect(ghMock).not.toHaveBeenCalled();
  });

  it('creates a PR from a spec file and body file', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'pr-body-248.md'), 'body', 'utf-8');
    await writeFile(
      path.join(outputDir, 'pr-spec-248.json'),
      JSON.stringify({
        title: 'feat(#248): migrate protocol',
        body_file: '.shipper/output/pr-body-248.md',
        base: 'main',
        head_branch: 'shipper/248-migrate-protocol',
        draft: false,
      }),
      'utf-8'
    );
    ghMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/248\n', stderr: '' });

    await expect(
      createPrFromSpec('owner/repo', tempDir, '.shipper/output/pr-spec-248.json')
    ).resolves.toBe('https://github.com/owner/repo/pull/248');

    expect(ghMock).toHaveBeenNthCalledWith(1, [
      'pr',
      'list',
      '-R',
      'owner/repo',
      '--head',
      'shipper/248-migrate-protocol',
      '--json',
      'url',
      '-q',
      '.[0].url',
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'pr',
      'create',
      '-R',
      'owner/repo',
      '--head',
      'shipper/248-migrate-protocol',
      '--base',
      'main',
      '--title',
      'feat(#248): migrate protocol',
      '--body-file',
      path.join(tempDir, '.shipper/output/pr-body-248.md'),
    ]);
  });

  it('short-circuits PR creation when a matching PR already exists', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'pr-body-248.md'), 'body', 'utf-8');
    await writeFile(
      path.join(outputDir, 'pr-spec-248.json'),
      JSON.stringify({
        title: 'feat(#248): migrate protocol',
        body_file: '.shipper/output/pr-body-248.md',
        base: 'main',
        head_branch: 'shipper/248-migrate-protocol',
        draft: true,
      }),
      'utf-8'
    );
    ghMock.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/248\n',
      stderr: '',
    });

    await expect(
      createPrFromSpec('owner/repo', tempDir, '.shipper/output/pr-spec-248.json')
    ).resolves.toBe('https://github.com/owner/repo/pull/248');

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(ghMock).toHaveBeenCalledWith([
      'pr',
      'list',
      '-R',
      'owner/repo',
      '--head',
      'shipper/248-migrate-protocol',
      '--json',
      'url',
      '-q',
      '.[0].url',
    ]);
  });

  it('submits a review payload through the GitHub reviews API', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    const payloadPath = path.join(outputDir, 'review-payload-248.json');
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      payloadPath,
      JSON.stringify({
        commit_id: 'abc123',
        body: 'Looks good.',
        event: 'APPROVE',
        comments: [
          {
            path: 'src/file.ts',
            line: 42,
            side: 'RIGHT',
            body: 'Nice.',
          },
        ],
      }),
      'utf-8'
    );
    ghMock
      .mockResolvedValueOnce({ stdout: 'reviewer\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'author\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await submitReviewPayload(
      'owner/repo',
      '248',
      tempDir,
      '.shipper/output/review-payload-248.json'
    );

    expect(ghMock).toHaveBeenNthCalledWith(1, ['api', 'user', '-q', '.login']);
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'pr',
      'view',
      '248',
      '-R',
      'owner/repo',
      '--json',
      'author',
      '--jq',
      '.author.login',
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(3, [
      'api',
      'repos/owner/repo/pulls/248/reviews',
      '--method',
      'POST',
      '--input',
      payloadPath,
    ]);
    await expect(readFile(payloadPath, 'utf-8')).resolves.toContain('"event":"APPROVE"');
  });

  it('downgrades self-authored approval reviews to comment before submission', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    const payloadPath = path.join(outputDir, 'review-payload-248.json');
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      payloadPath,
      JSON.stringify({
        commit_id: 'abc123',
        body: 'Needs follow-up.',
        event: 'REQUEST_CHANGES',
        comments: [],
      }),
      'utf-8'
    );
    ghMock
      .mockResolvedValueOnce({ stdout: 'author\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'author\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await submitReviewPayload(
      'owner/repo',
      '248',
      tempDir,
      '.shipper/output/review-payload-248.json'
    );

    await expect(readFile(payloadPath, 'utf-8')).resolves.toContain('"event":"COMMENT"');
    expect(ghMock).toHaveBeenNthCalledWith(3, [
      'api',
      'repos/owner/repo/pulls/248/reviews',
      '--method',
      'POST',
      '--input',
      payloadPath,
    ]);
  });

  it('rejects review comments that include only one multiline range field', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, 'review-payload-248.json'),
      JSON.stringify({
        commit_id: 'abc123',
        body: 'Needs work.',
        event: 'COMMENT',
        comments: [
          {
            path: 'src/file.ts',
            line: 42,
            side: 'RIGHT',
            body: 'Range is incomplete.',
            start_line: 40,
          },
        ],
      }),
      'utf-8'
    );

    await expect(
      submitReviewPayload('owner/repo', '248', tempDir, '.shipper/output/review-payload-248.json')
    ).rejects.toThrow(
      "'comments[0].start_line' and 'comments[0].start_side' must be provided together"
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('processes a plain result by posting the comment before changing labels', async () => {
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

  it('processes PR creation before posting the comment and changing labels', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'pr-body-248.md'), 'body', 'utf-8');
    await writeFile(
      path.join(outputDir, 'pr-spec-248.json'),
      JSON.stringify({
        title: 'feat(#248): migrate protocol',
        body_file: '.shipper/output/pr-body-248.md',
        base: 'main',
        head_branch: 'shipper/248-migrate-protocol',
        draft: false,
      }),
      'utf-8'
    );
    await writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify({
        verdict: 'accept',
        comment: '.shipper/output/comment-248.md',
        pr_spec: '.shipper/output/pr-spec-248.json',
      }),
      'utf-8'
    );
    await writeFile(path.join(outputDir, 'comment-248.md'), 'summary', 'utf-8');
    ghMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/248\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(
      processResult({
        repo: 'owner/repo',
        issueNumber: '248',
        stage: 'pr_open',
        cwd: tempDir,
      })
    ).resolves.toEqual({
      verdict: 'accept',
      comment: '.shipper/output/comment-248.md',
      pr_spec: '.shipper/output/pr-spec-248.json',
    });

    expect(ghMock).toHaveBeenNthCalledWith(1, [
      'pr',
      'list',
      '-R',
      'owner/repo',
      '--head',
      'shipper/248-migrate-protocol',
      '--json',
      'url',
      '-q',
      '.[0].url',
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'pr',
      'create',
      '-R',
      'owner/repo',
      '--head',
      'shipper/248-migrate-protocol',
      '--base',
      'main',
      '--title',
      'feat(#248): migrate protocol',
      '--body-file',
      path.join(tempDir, '.shipper/output/pr-body-248.md'),
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(3, [
      'issue',
      'comment',
      '248',
      '-R',
      'owner/repo',
      '--body-file',
      path.join(tempDir, '.shipper/output/comment-248.md'),
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(4, [
      'issue',
      'edit',
      '248',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:pr-open',
      '--remove-label',
      'shipper:implemented',
    ]);
  });

  it('rejects PR side effects for non-pr_open stages', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify({
        verdict: 'accept',
        comment: '.shipper/output/comment-248.md',
        pr_spec: '.shipper/output/pr-spec-248.json',
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
    ).rejects.toThrow('result.pr_spec is only supported for the pr_open stage');
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('processes review submission before posting the comment and changing labels', async () => {
    const outputDir = path.join(tempDir, PROTOCOL_OUTPUT_DIR);
    const payloadPath = path.join(outputDir, 'review-payload-248.json');
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      payloadPath,
      JSON.stringify({
        commit_id: 'abc123',
        body: 'Looks good.',
        event: 'APPROVE',
        comments: [],
      }),
      'utf-8'
    );
    await writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify({
        verdict: 'accept',
        comment: '.shipper/output/comment-248.md',
        review_payload: '.shipper/output/review-payload-248.json',
      }),
      'utf-8'
    );
    await writeFile(path.join(outputDir, 'comment-248.md'), 'summary', 'utf-8');
    ghMock
      .mockResolvedValueOnce({ stdout: 'reviewer\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'author\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await expect(
      processResult({
        repo: 'owner/repo',
        issueNumber: '248',
        stage: 'pr_review',
        cwd: tempDir,
        prNumber: '77',
      })
    ).resolves.toEqual({
      verdict: 'accept',
      comment: '.shipper/output/comment-248.md',
      review_payload: '.shipper/output/review-payload-248.json',
    });

    expect(ghMock).toHaveBeenNthCalledWith(1, ['api', 'user', '-q', '.login']);
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'pr',
      'view',
      '77',
      '-R',
      'owner/repo',
      '--json',
      'author',
      '--jq',
      '.author.login',
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(3, [
      'api',
      'repos/owner/repo/pulls/77/reviews',
      '--method',
      'POST',
      '--input',
      payloadPath,
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(4, [
      'issue',
      'comment',
      '248',
      '-R',
      'owner/repo',
      '--body-file',
      path.join(tempDir, '.shipper/output/comment-248.md'),
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(5, [
      'issue',
      'edit',
      '248',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:pr-reviewed',
      '--remove-label',
      'shipper:pr-open',
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
