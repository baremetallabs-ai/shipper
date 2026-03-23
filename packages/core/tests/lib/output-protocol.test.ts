import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResultJson } from '../../src/lib/result-schema.js';

const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();

vi.mock('../../src/lib/gh.js', () => ({
  gh: (...args: unknown[]) => {
    return ghMock(...(args as [string[]]));
  },
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
  retryOnInvalidOutput,
  scrubOutputDir,
  submitReviewPayload,
  setupProtocolDirs,
  validateStageOutput,
  writeContextFile,
} = await import('../../src/lib/output-protocol.js');

describe('output protocol helpers', () => {
  let tempDir: string;

  function outputRelative(name: string): string {
    return path.posix.join('.shipper', 'output', name);
  }

  function outputAbs(name: string): string {
    return path.join(tempDir, PROTOCOL_OUTPUT_DIR, name);
  }

  async function ensureOutputDir(): Promise<void> {
    await mkdir(path.join(tempDir, PROTOCOL_OUTPUT_DIR), { recursive: true });
  }

  async function writeOutputFile(name: string, content: string): Promise<string> {
    await ensureOutputDir();
    const filePath = outputAbs(name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  async function writeOutputJson(name: string, data: unknown): Promise<string> {
    return await writeOutputFile(name, JSON.stringify(data));
  }

  async function writeResultFile(result: Record<string, unknown>): Promise<string> {
    return await writeOutputJson('result.json', result);
  }

  function buildResult(overrides: Partial<ResultJson> = {}): ResultJson {
    return {
      verdict: 'accept',
      comment: outputRelative('comment-248.md'),
      ...overrides,
    };
  }

  function buildPrSpec(
    overrides: Partial<{
      title: string;
      body_file: string;
      base: string;
      head_branch: string;
      draft: boolean;
    }> = {}
  ) {
    return {
      title: 'feat(#248): migrate protocol',
      body_file: outputRelative('pr-body-248.md'),
      base: 'main',
      head_branch: 'shipper/248-migrate-protocol',
      draft: false,
      ...overrides,
    };
  }

  function buildReviewPayload(
    overrides: Partial<{
      commit_id: string;
      body: string;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      comments: Array<{
        path: string;
        line: number;
        side: 'LEFT' | 'RIGHT';
        body: string;
        start_line?: number;
        start_side?: 'LEFT' | 'RIGHT';
      }>;
    }> = {}
  ) {
    return {
      commit_id: 'abc123',
      body: 'Looks good.',
      event: 'APPROVE' as const,
      comments: [],
      ...overrides,
    };
  }

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

    const inputDirStat = await stat(path.join(tempDir, PROTOCOL_INPUT_DIR));
    const outputDirStat = await stat(path.join(tempDir, PROTOCOL_OUTPUT_DIR));

    expect(inputDirStat.isDirectory()).toBe(true);
    expect(outputDirStat.isDirectory()).toBe(true);
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

    await postReplies('owner/repo', '248', tempDir, outputRelative('replies'));

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
    await postReplies('owner/repo', '248', tempDir, outputRelative('replies'));

    expect(ghMock).not.toHaveBeenCalled();
  });

  it('creates a PR from a spec file and body file', async () => {
    await writeOutputFile('pr-body-248.md', 'body');
    await writeOutputJson('pr-spec-248.json', buildPrSpec());
    ghMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/248\n', stderr: '' });

    await expect(
      createPrFromSpec('owner/repo', tempDir, outputRelative('pr-spec-248.json'))
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
      outputAbs('pr-body-248.md'),
    ]);
  });

  it('short-circuits PR creation when a matching PR already exists', async () => {
    await writeOutputFile('pr-body-248.md', 'body');
    await writeOutputJson('pr-spec-248.json', buildPrSpec({ draft: true }));
    ghMock.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/248\n',
      stderr: '',
    });

    await expect(
      createPrFromSpec('owner/repo', tempDir, outputRelative('pr-spec-248.json'))
    ).resolves.toBe('https://github.com/owner/repo/pull/248');

    expect(ghMock).toHaveBeenCalledTimes(1);
  });

  it('submits a review payload through the GitHub reviews API', async () => {
    const payloadPath = await writeOutputJson(
      'review-payload-248.json',
      buildReviewPayload({
        comments: [
          {
            path: 'src/file.ts',
            line: 42,
            side: 'RIGHT',
            body: 'Nice.',
          },
        ],
      })
    );
    ghMock
      .mockResolvedValueOnce({ stdout: 'reviewer\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'author\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await submitReviewPayload(
      'owner/repo',
      '248',
      tempDir,
      outputRelative('review-payload-248.json')
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
    const payloadPath = await writeOutputJson(
      'review-payload-248.json',
      buildReviewPayload({ event: 'REQUEST_CHANGES' })
    );
    ghMock
      .mockResolvedValueOnce({ stdout: 'author\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'author\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await submitReviewPayload(
      'owner/repo',
      '248',
      tempDir,
      outputRelative('review-payload-248.json')
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
    await writeOutputJson(
      'review-payload-248.json',
      buildReviewPayload({
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
      })
    );

    await expect(
      submitReviewPayload('owner/repo', '248', tempDir, outputRelative('review-payload-248.json'))
    ).rejects.toThrow(
      "'comments[0].start_line' and 'comments[0].start_side' must be provided together"
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  describe('validateStageOutput', () => {
    it('rejects PR specs on non-pr_open stages', async () => {
      await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));

      await expect(validateStageOutput(tempDir, 'plan')).rejects.toThrow(
        'result.pr_spec is only supported for the pr_open stage'
      );
    });

    it('rejects review payloads on non-pr_review stages', async () => {
      await writeResultFile(
        buildResult({ review_payload: outputRelative('review-payload-248.json') })
      );

      await expect(validateStageOutput(tempDir, 'design')).rejects.toThrow(
        'result.review_payload is only supported for the pr_review stage'
      );
    });

    it('rejects pr_open accepts without a pr_spec', async () => {
      await writeResultFile(buildResult());

      await expect(validateStageOutput(tempDir, 'pr_open')).rejects.toThrow(
        'pr_open accept requires a pr_spec in result.json'
      );
    });

    it('rejects pr_review accepts without a review_payload', async () => {
      await writeResultFile(buildResult());

      await expect(validateStageOutput(tempDir, 'pr_review')).rejects.toThrow(
        'pr_review accept requires a review_payload in result.json'
      );
    });

    it('treats pr_remediate as schema-only validation', async () => {
      const result = buildResult();
      await writeResultFile(result);

      await expect(validateStageOutput(tempDir, 'pr_remediate')).resolves.toEqual(result);
    });

    it('rejects malformed PR spec JSON', async () => {
      await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
      await writeOutputFile('pr-spec-248.json', '{invalid');

      await expect(validateStageOutput(tempDir, 'pr_open')).rejects.toThrow(
        `Failed to parse PR spec at ${outputAbs('pr-spec-248.json')}`
      );
    });

    it('rejects PR specs that are not JSON objects', async () => {
      await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
      await writeOutputJson('pr-spec-248.json', ['not-an-object']);

      await expect(validateStageOutput(tempDir, 'pr_open')).rejects.toThrow(
        `Invalid PR spec at ${outputAbs('pr-spec-248.json')}:\n- PR spec must be a JSON object`
      );
    });

    it('rejects PR specs missing required fields', async () => {
      await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
      const invalidSpec = buildPrSpec();
      delete (invalidSpec as Partial<typeof invalidSpec>).title;
      await writeOutputJson('pr-spec-248.json', invalidSpec);

      await expect(validateStageOutput(tempDir, 'pr_open')).rejects.toThrow(
        "'title' must be a string"
      );
    });

    it('rejects PR body paths that escape the output directory', async () => {
      await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
      await writeOutputJson(
        'pr-spec-248.json',
        buildPrSpec({ body_file: '.shipper/input/pr-body-248.md' })
      );

      await expect(validateStageOutput(tempDir, 'pr_open')).rejects.toThrow(
        `PR body path must stay within ${path.join(tempDir, PROTOCOL_OUTPUT_DIR)}`
      );
    });

    it('rejects missing PR body files', async () => {
      await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
      await writeOutputJson('pr-spec-248.json', buildPrSpec());

      await expect(validateStageOutput(tempDir, 'pr_open')).rejects.toThrow(
        `PR body path does not exist: ${outputAbs('pr-body-248.md')}`
      );
    });

    it('rejects malformed review payload JSON', async () => {
      await writeResultFile(
        buildResult({ review_payload: outputRelative('review-payload-248.json') })
      );
      await writeOutputFile('review-payload-248.json', '{invalid');

      await expect(validateStageOutput(tempDir, 'pr_review')).rejects.toThrow(
        `Failed to parse review payload at ${outputAbs('review-payload-248.json')}`
      );
    });

    it('rejects review payloads that are not JSON objects', async () => {
      await writeResultFile(
        buildResult({ review_payload: outputRelative('review-payload-248.json') })
      );
      await writeOutputJson('review-payload-248.json', ['not-an-object']);

      await expect(validateStageOutput(tempDir, 'pr_review')).rejects.toThrow(
        `Invalid review payload at ${outputAbs('review-payload-248.json')}:\n- review payload must be a JSON object`
      );
    });

    it('rejects review payloads missing required fields', async () => {
      await writeResultFile(
        buildResult({ review_payload: outputRelative('review-payload-248.json') })
      );
      const invalidPayload = buildReviewPayload();
      delete (invalidPayload as Partial<typeof invalidPayload>).commit_id;
      await writeOutputJson('review-payload-248.json', invalidPayload);

      await expect(validateStageOutput(tempDir, 'pr_review')).rejects.toThrow(
        "'commit_id' must be a string"
      );
    });

    it('returns the parsed result for valid pr_open output', async () => {
      const result = buildResult({ pr_spec: outputRelative('pr-spec-248.json') });
      await writeResultFile(result);
      await writeOutputFile('pr-body-248.md', 'body');
      await writeOutputJson('pr-spec-248.json', buildPrSpec());

      await expect(validateStageOutput(tempDir, 'pr_open')).resolves.toEqual(result);
    });

    it('returns the parsed result for valid pr_review output', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      await writeResultFile(result);
      await writeOutputJson('review-payload-248.json', buildReviewPayload());

      await expect(validateStageOutput(tempDir, 'pr_review')).resolves.toEqual(result);
    });
  });

  describe('processResult', () => {
    it('processes a plain result by posting the comment before changing labels', async () => {
      const result = buildResult();
      await writeOutputFile('comment-248.md', 'summary');

      await expect(
        processResult({
          repo: 'owner/repo',
          issueNumber: '248',
          stage: 'plan',
          cwd: tempDir,
          result,
        })
      ).resolves.toEqual(result);

      expect(ghMock).toHaveBeenNthCalledWith(1, [
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body-file',
        outputAbs('comment-248.md'),
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
      const result = buildResult({ pr_spec: outputRelative('pr-spec-248.json') });
      await writeOutputFile('comment-248.md', 'summary');
      await writeOutputFile('pr-body-248.md', 'body');
      await writeOutputJson('pr-spec-248.json', buildPrSpec());
      ghMock
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({
          stdout: 'https://github.com/owner/repo/pull/248\n',
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(
        processResult({
          repo: 'owner/repo',
          issueNumber: '248',
          stage: 'pr_open',
          cwd: tempDir,
          result,
        })
      ).resolves.toEqual(result);

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
        outputAbs('pr-body-248.md'),
      ]);
      expect(ghMock).toHaveBeenNthCalledWith(3, [
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body-file',
        outputAbs('comment-248.md'),
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

    it('processes review submission before posting the comment and changing labels', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      await writeOutputFile('comment-248.md', 'summary');
      await writeOutputJson('review-payload-248.json', buildReviewPayload());
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
          result,
          prNumber: '77',
        })
      ).resolves.toEqual(result);

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
        outputAbs('review-payload-248.json'),
      ]);
      expect(ghMock).toHaveBeenNthCalledWith(4, [
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body-file',
        outputAbs('comment-248.md'),
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

    it('requires a PR number when posting a review payload', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      await writeOutputFile('comment-248.md', 'summary');

      await expect(
        processResult({
          repo: 'owner/repo',
          issueNumber: '248',
          stage: 'pr_review',
          cwd: tempDir,
          result,
        })
      ).rejects.toThrow('review payload requires a PR number');
    });

    it('rejects comment paths that escape the protocol output directory', async () => {
      await expect(
        processResult({
          repo: 'owner/repo',
          issueNumber: '248',
          stage: 'design',
          cwd: tempDir,
          result: buildResult({ comment: '.shipper/input/comment-248.md' }),
        })
      ).rejects.toThrow(`comment path must stay within ${path.join(tempDir, PROTOCOL_OUTPUT_DIR)}`);

      expect(ghMock).not.toHaveBeenCalled();
    });
  });

  describe('retryOnInvalidOutput', () => {
    it('does not retry when output is already valid', async () => {
      const result = buildResult({ verdict: 'reject' });
      const retryMock = vi.fn<(message: string) => Promise<number>>().mockResolvedValue(1);
      await writeResultFile(result);

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'design',
          retry: retryMock,
        })
      ).resolves.toEqual(result);

      expect(retryMock).not.toHaveBeenCalled();
    });

    it('retries when pr_open accept omits pr_spec', async () => {
      const retryMock = vi.fn<(message: string) => Promise<number>>().mockResolvedValue(0);
      await writeResultFile(buildResult());

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_open',
          retry: retryMock,
        })
      ).rejects.toThrow('pr_open accept requires a pr_spec in result.json');

      expect(retryMock).toHaveBeenCalledWith(
        [
          'Your previous output was invalid. Fix the following and produce a valid .shipper/output/result.json:',
          '- pr_open accept requires a pr_spec in result.json',
        ].join('\n')
      );
    });

    it('retries when pr_review accept omits review_payload', async () => {
      const retryMock = vi.fn<(message: string) => Promise<number>>().mockResolvedValue(0);
      await writeResultFile(buildResult());

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_review',
          retry: retryMock,
        })
      ).rejects.toThrow('pr_review accept requires a review_payload in result.json');

      expect(retryMock).toHaveBeenCalledWith(
        [
          'Your previous output was invalid. Fix the following and produce a valid .shipper/output/result.json:',
          '- pr_review accept requires a review_payload in result.json',
        ].join('\n')
      );
    });

    it('retries when the PR spec is incomplete', async () => {
      const retryMock = vi.fn<(message: string) => Promise<number>>().mockResolvedValue(0);
      await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
      const invalidSpec = buildPrSpec();
      delete (invalidSpec as Partial<typeof invalidSpec>).title;
      await writeOutputJson('pr-spec-248.json', invalidSpec);

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_open',
          retry: retryMock,
        })
      ).rejects.toThrow("'title' must be a string");

      expect(retryMock).toHaveBeenCalledWith(expect.stringContaining("- 'title' must be a string"));
    });

    it('returns the revalidated output after retry repairs it', async () => {
      const repairedResult = buildResult({ pr_spec: outputRelative('pr-spec-248.json') });
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeResultFile(repairedResult);
          await writeOutputFile('pr-body-248.md', 'body');
          await writeOutputJson('pr-spec-248.json', buildPrSpec());
          return 0;
        });
      await writeResultFile(buildResult());

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_open',
          retry: retryMock,
        })
      ).resolves.toEqual(repairedResult);
    });

    it('accepts valid retry output even when the retry exit code is non-zero', async () => {
      const repairedResult = buildResult({ pr_spec: outputRelative('pr-spec-248.json') });
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeResultFile(repairedResult);
          await writeOutputFile('pr-body-248.md', 'body');
          await writeOutputJson('pr-spec-248.json', buildPrSpec());
          return 17;
        });
      await writeResultFile(buildResult());

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_open',
          retry: retryMock,
        })
      ).resolves.toEqual(repairedResult);
    });

    it('rethrows the second validation error when retry output is still invalid', async () => {
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
          const invalidSpec = buildPrSpec();
          delete (invalidSpec as Partial<typeof invalidSpec>).title;
          await writeOutputJson('pr-spec-248.json', invalidSpec);
          return 0;
        });
      await writeResultFile(buildResult());

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_open',
          retry: retryMock,
        })
      ).rejects.toThrow("'title' must be a string");

      expect(retryMock).toHaveBeenCalledTimes(1);
    });
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

  it('allows a custom crash summary when the failure happens after valid output exists', async () => {
    await handleAgentCrash(
      'owner/repo',
      '248',
      'pr_remediate',
      'fatal: unable to access remote',
      'The `pr_remediate` agent run failed while pushing the remediation worktree after producing a valid `.shipper/output/result.json`.'
    );

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
        'The `pr_remediate` agent run failed while pushing the remediation worktree after producing a valid `.shipper/output/result.json`.',
        '',
        'fatal: unable to access remote',
      ].join('\n'),
    ]);
  });
});
