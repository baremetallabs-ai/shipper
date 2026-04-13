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
  createPrFromSpecWithMetadata,
  PROTOCOL_INPUT_DIR,
  PROTOCOL_OUTPUT_DIR,
  executeTransition,
  formatCorrectionMessage,
  handleAgentCrash,
  postComment,
  postReplies,
  processResult,
  parseDiffHunks,
  retryOnInvalidOutput,
  scrubOutputDir,
  submitReviewPayload,
  setupProtocolDirs,
  truncateLargeInput,
  validateStageOutput,
  writeContextFile,
} = await import('../../src/lib/output-protocol/index.js');

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

  function buildReviewDiffFixture(): string {
    return [
      'diff --git a/src/file.ts b/src/file.ts',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -10,5 +10,6 @@',
      ' context',
      '@@ -30 +31 @@',
      ' context',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,3 @@',
      '+export const created = true;',
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -4,2 +0,0 @@',
      '-legacy',
      '-code',
    ].join('\n');
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

  it('returns below-threshold input unchanged without writing a context file', async () => {
    const text = 'small error output';

    await expect(truncateLargeInput(tempDir, text, 'push-error.txt')).resolves.toBe(text);
    await expect(
      readFile(path.join(tempDir, PROTOCOL_INPUT_DIR, 'push-error.txt'), 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes oversized input to .shipper/input and returns a head-tail summary', async () => {
    const lines = Array.from({ length: 140 }, (_, index) => `${'x'.repeat(400)} line ${index + 1}`);
    const oversized = lines.join('\n');

    const truncated = await truncateLargeInput(tempDir, oversized, 'install-error.txt');

    await expect(
      readFile(path.join(tempDir, PROTOCOL_INPUT_DIR, 'install-error.txt'), 'utf-8')
    ).resolves.toBe(oversized);
    expect(truncated).toContain('line 1');
    expect(truncated).toContain('line 50');
    expect(truncated).toContain('line 91');
    expect(truncated).toContain('line 140');
    expect(truncated).toContain(
      '[40 lines omitted; full output written to .shipper/input/install-error.txt]'
    );
  });

  it('caps line-based summaries so wide log lines still shrink inline', async () => {
    const lines = Array.from(
      { length: 101 },
      (_, index) => `line ${index + 1} ${'界'.repeat(4_000)}`
    );
    const oversized = lines.join('\n');

    const truncated = await truncateLargeInput(tempDir, oversized, 'push-error.txt');

    await expect(
      readFile(path.join(tempDir, PROTOCOL_INPUT_DIR, 'push-error.txt'), 'utf-8')
    ).resolves.toBe(oversized);
    expect(truncated).toContain(
      '[1 lines omitted; full output written to .shipper/input/push-error.txt]'
    );
    expect(Buffer.byteLength(truncated, 'utf-8')).toBeLessThan(60_000);
    expect(truncated).not.toContain('\uFFFD');
  });

  it('avoids duplicating short-but-huge input when truncating inline content', async () => {
    const oversized = 'A'.repeat(60_000);

    const truncated = await truncateLargeInput(tempDir, oversized, 'conflict-context.txt');

    await expect(
      readFile(path.join(tempDir, PROTOCOL_INPUT_DIR, 'conflict-context.txt'), 'utf-8')
    ).resolves.toBe(oversized);
    expect(truncated).toContain('full output written to .shipper/input/conflict-context.txt');
    expect(truncated).toContain('bytes omitted');
    expect(truncated.length).toBeLessThan(oversized.length);
  });

  it('posts label transitions to the issue first, then mirrors them to the PR when provided', async () => {
    await executeTransition(
      'owner/repo',
      '248',
      {
        add: ['shipper:planned'],
        remove: ['shipper:designed'],
      },
      '84'
    );

    expect(ghMock).toHaveBeenNthCalledWith(1, [
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
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'pr',
      'edit',
      '84',
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

  it('treats PR mirror failures as warnings after a successful issue edit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ghMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('pr edit failed'));

    await expect(
      executeTransition(
        'owner/repo',
        '248',
        {
          add: ['shipper:failed'],
          remove: ['shipper:pr-reviewed'],
        },
        '84'
      )
    ).resolves.toBeUndefined();

    expect(ghMock).toHaveBeenNthCalledWith(1, [
      'issue',
      'edit',
      '248',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:failed',
      '--remove-label',
      'shipper:pr-reviewed',
    ]);
    expect(ghMock).toHaveBeenNthCalledWith(2, [
      'pr',
      'edit',
      '84',
      '-R',
      'owner/repo',
      '--add-label',
      'shipper:failed',
      '--remove-label',
      'shipper:pr-reviewed',
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[shipper] Warning: Failed to mirror transition labels onto PR #84: pr edit failed'
    );

    warnSpy.mockRestore();
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

  it('creates a PR from a spec file and returns metadata when requested', async () => {
    await writeOutputFile('pr-body-248.md', 'body');
    await writeOutputJson('pr-spec-248.json', buildPrSpec());
    ghMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/248/\n', stderr: '' });

    await expect(
      createPrFromSpecWithMetadata('owner/repo', tempDir, outputRelative('pr-spec-248.json'))
    ).resolves.toEqual({
      url: 'https://github.com/owner/repo/pull/248/',
      number: 248,
    });
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

  it('returns metadata for an existing PR without creating a new PR', async () => {
    await writeOutputFile('pr-body-248.md', 'body');
    await writeOutputJson('pr-spec-248.json', buildPrSpec({ draft: true }));
    ghMock.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/248\n',
      stderr: '',
    });

    await expect(
      createPrFromSpecWithMetadata('owner/repo', tempDir, outputRelative('pr-spec-248.json'))
    ).resolves.toEqual({
      url: 'https://github.com/owner/repo/pull/248',
      number: 248,
    });
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

  describe('parseDiffHunks', () => {
    it('parses multiple hunks in a file plus new and deleted file ranges', () => {
      const diffHunks = parseDiffHunks(buildReviewDiffFixture());

      expect(diffHunks.get('src/file.ts')).toEqual({
        left: [
          [10, 14],
          [30, 30],
        ],
        right: [
          [10, 15],
          [31, 31],
        ],
      });
      expect(diffHunks.get('src/new.ts')).toEqual({
        left: [],
        right: [[1, 3]],
      });
      expect(diffHunks.get('src/old.ts')).toEqual({
        left: [[4, 5]],
        right: [],
      });
    });

    it('parses quoted file headers with metadata and ignores hunk lines that look like headers', () => {
      const diff = [
        'diff --git "a/src/file with space.ts" "b/src/file with space.ts"',
        '--- "a/src/file with space.ts"\t2026-04-01 00:00:00 +0000\r',
        '+++ "b/src/file with space.ts"\t2026-04-01 00:00:00 +0000\r',
        '@@ -1 +1,2 @@',
        ' context',
        '+++ this is file content, not a header',
        '@@ -10 +11 @@',
        ' context',
      ].join('\n');

      const diffHunks = parseDiffHunks(diff);

      expect(diffHunks.get('src/file with space.ts')).toEqual({
        left: [
          [1, 1],
          [10, 10],
        ],
        right: [
          [1, 2],
          [11, 11],
        ],
      });
      expect(diffHunks.has('this is file content, not a header')).toBe(false);
    });
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

    it('accepts pr_review output when all comment paths match the PR diff files', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      await writeResultFile(result);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          comments: [
            {
              path: 'src/file.ts',
              line: 12,
              side: 'RIGHT',
              body: 'Needs a test.',
            },
            {
              path: 'README.md',
              line: 3,
              side: 'RIGHT',
              body: 'Update the usage docs.',
            },
          ],
        })
      );

      await expect(
        validateStageOutput(tempDir, 'pr_review', new Set(['src/file.ts', 'README.md']))
      ).resolves.toEqual(result);
    });

    it('rejects pr_review output when a comment line is outside every diff hunk', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      const diffHunks = parseDiffHunks(buildReviewDiffFixture());
      await writeResultFile(result);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          comments: [
            {
              path: 'src/file.ts',
              line: 45,
              side: 'RIGHT',
              body: 'This line is not commentable.',
            },
          ],
        })
      );

      await expect(
        validateStageOutput(
          tempDir,
          'pr_review',
          new Set(['src/file.ts', 'src/new.ts', 'src/old.ts']),
          diffHunks
        )
      ).rejects.toThrow(
        "comments[0].line 45 (side RIGHT) is not within any diff hunk for 'src/file.ts'. Valid ranges — LEFT: 10-14, 30-30; RIGHT: 10-15, 31-31"
      );
    });

    it('rejects pr_review output when a multiline start_line is outside every diff hunk', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      const diffHunks = parseDiffHunks(buildReviewDiffFixture());
      await writeResultFile(result);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          comments: [
            {
              path: 'src/file.ts',
              line: 12,
              side: 'RIGHT',
              body: 'This multiline range starts outside any hunk.',
              start_line: 45,
              start_side: 'RIGHT',
            },
          ],
        })
      );

      await expect(
        validateStageOutput(
          tempDir,
          'pr_review',
          new Set(['src/file.ts', 'src/new.ts', 'src/old.ts']),
          diffHunks
        )
      ).rejects.toThrow(
        "comments[0].start_line 45 (side RIGHT) is not within any diff hunk for 'src/file.ts'. Valid ranges — LEFT: 10-14, 30-30; RIGHT: 10-15, 31-31"
      );
    });

    it('rejects pr_review output when a comment side does not match the diff hunk side', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      const diffHunks = parseDiffHunks(buildReviewDiffFixture());
      await writeResultFile(result);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          comments: [
            {
              path: 'src/old.ts',
              line: 4,
              side: 'RIGHT',
              body: 'Deleted lines are only commentable on the left.',
            },
          ],
        })
      );

      await expect(
        validateStageOutput(
          tempDir,
          'pr_review',
          new Set(['src/file.ts', 'src/new.ts', 'src/old.ts']),
          diffHunks
        )
      ).rejects.toThrow(
        "comments[0].line 4 (side RIGHT) is not within any diff hunk for 'src/old.ts'. Valid ranges — LEFT: 4-5"
      );
    });

    it('preserves the original comment index in diff-hunk validation errors', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      const diffHunks = parseDiffHunks(buildReviewDiffFixture());
      await writeResultFile(result);
      await writeOutputJson('review-payload-248.json', {
        ...buildReviewPayload(),
        comments: [
          {
            path: 'src/file.ts',
            line: 'twelve',
            side: 'RIGHT',
            body: 'Schema-invalid comment that should not shift indexes.',
          },
          {
            path: 'src/file.ts',
            line: 45,
            side: 'RIGHT',
            body: 'This line is outside any hunk.',
          },
        ],
      });

      await expect(
        validateStageOutput(
          tempDir,
          'pr_review',
          new Set(['src/file.ts', 'src/new.ts', 'src/old.ts']),
          diffHunks
        )
      ).rejects.toThrow(
        "comments[1].line 45 (side RIGHT) is not within any diff hunk for 'src/file.ts'. Valid ranges — LEFT: 10-14, 30-30; RIGHT: 10-15, 31-31"
      );
    });

    it('rejects pr_review output when comment paths are outside the PR diff files', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      await writeResultFile(result);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          comments: [
            {
              path: 'src/file.ts',
              line: 12,
              side: 'RIGHT',
              body: 'Needs a test.',
            },
            {
              path: 'src/missing.ts',
              line: 18,
              side: 'RIGHT',
              body: 'This file is not in the diff.',
            },
            {
              path: 'docs/missing.md',
              line: 4,
              side: 'RIGHT',
              body: 'Also outside the diff.',
            },
          ],
        })
      );

      await expect(
        validateStageOutput(tempDir, 'pr_review', new Set(['src/file.ts', 'README.md']))
      ).rejects.toThrow(
        'comment path(s) not in PR diff: src/missing.ts, docs/missing.md. Valid files: src/file.ts, README.md'
      );
    });

    it('summarizes large valid file lists in invalid-path errors', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      await writeResultFile(result);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          comments: [
            {
              path: 'src/missing.ts',
              line: 18,
              side: 'RIGHT',
              body: 'This file is not in the diff.',
            },
          ],
        })
      );
      const prFiles = new Set(Array.from({ length: 55 }, (_, index) => `src/file-${index + 1}.ts`));

      await expect(validateStageOutput(tempDir, 'pr_review', prFiles)).rejects.toThrow(
        'comment path(s) not in PR diff: src/missing.ts. Valid files: src/file-1.ts, src/file-2.ts, src/file-3.ts, src/file-4.ts, src/file-5.ts, src/file-6.ts, src/file-7.ts, src/file-8.ts, src/file-9.ts, src/file-10.ts, src/file-11.ts, src/file-12.ts, src/file-13.ts, src/file-14.ts, src/file-15.ts, src/file-16.ts, src/file-17.ts, src/file-18.ts, src/file-19.ts, src/file-20.ts, src/file-21.ts, src/file-22.ts, src/file-23.ts, src/file-24.ts, src/file-25.ts, src/file-26.ts, src/file-27.ts, src/file-28.ts, src/file-29.ts, src/file-30.ts, src/file-31.ts, src/file-32.ts, src/file-33.ts, src/file-34.ts, src/file-35.ts, src/file-36.ts, src/file-37.ts, src/file-38.ts, src/file-39.ts, src/file-40.ts, src/file-41.ts, src/file-42.ts, src/file-43.ts, src/file-44.ts, src/file-45.ts, src/file-46.ts, src/file-47.ts, src/file-48.ts, src/file-49.ts, src/file-50.ts (and 5 more)'
      );
    });

    it('accepts pr_review output when comment lines and sides match parsed diff hunks', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      const diffHunks = parseDiffHunks(buildReviewDiffFixture());
      await writeResultFile(result);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          event: 'COMMENT',
          comments: [
            {
              path: 'src/file.ts',
              line: 12,
              side: 'RIGHT',
              body: 'Single-line comment on a valid right-side line.',
            },
            {
              path: 'src/file.ts',
              line: 15,
              side: 'RIGHT',
              body: 'Multiline comment fully inside the first hunk.',
              start_line: 10,
              start_side: 'RIGHT',
            },
            {
              path: 'src/old.ts',
              line: 4,
              side: 'LEFT',
              body: 'Deleted lines remain valid on the left side.',
            },
          ],
        })
      );

      await expect(
        validateStageOutput(
          tempDir,
          'pr_review',
          new Set(['src/file.ts', 'src/new.ts', 'src/old.ts']),
          diffHunks
        )
      ).resolves.toEqual(result);
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

    it('processes PR creation before posting the comment and mirrors the transition onto the PR', async () => {
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
      expect(ghMock).toHaveBeenNthCalledWith(5, [
        'pr',
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

    it('processes review submission before posting the comment and mirrors the transition onto the PR', async () => {
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
      expect(ghMock).toHaveBeenNthCalledWith(6, [
        'pr',
        'edit',
        '77',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:pr-reviewed',
        '--remove-label',
        'shipper:pr-open',
      ]);
    });

    it.each([
      ['pr_open', 'reject', '66', ['shipper:planned'], ['shipper:implemented']],
      ['pr_open', 'fail', '66', ['shipper:failed'], ['shipper:implemented']],
      ['pr_review', 'reject', '77', ['shipper:implemented'], ['shipper:pr-open']],
      ['pr_review', 'fail', '77', ['shipper:failed'], ['shipper:pr-open']],
      ['pr_remediate', 'reject', '88', ['shipper:pr-open'], ['shipper:pr-reviewed']],
      ['pr_remediate', 'fail', '88', ['shipper:failed'], ['shipper:pr-reviewed']],
    ] as const)(
      'mirrors %s %s transitions onto the provided PR',
      async (stage, verdict, prNumber, addedLabels, removedLabels) => {
        const result = buildResult({ verdict });
        await writeOutputFile('comment-248.md', 'summary');

        await expect(
          processResult({
            repo: 'owner/repo',
            issueNumber: '248',
            stage,
            cwd: tempDir,
            result,
            prNumber,
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
          ...addedLabels.flatMap((label) => ['--add-label', label]),
          ...removedLabels.flatMap((label) => ['--remove-label', label]),
        ]);
        expect(ghMock).toHaveBeenNthCalledWith(3, [
          'pr',
          'edit',
          prNumber,
          '-R',
          'owner/repo',
          ...addedLabels.flatMap((label) => ['--add-label', label]),
          ...removedLabels.flatMap((label) => ['--remove-label', label]),
        ]);
      }
    );

    it.each(['design', 'plan', 'implement', 'unblock'] as const)(
      'does not mirror non-PR stage %s transitions even when prNumber is supplied',
      async (stage) => {
        const result = buildResult();
        await writeOutputFile('comment-248.md', 'summary');

        await expect(
          processResult({
            repo: 'owner/repo',
            issueNumber: '248',
            stage,
            cwd: tempDir,
            result,
            prNumber: '77',
          })
        ).resolves.toEqual(result);

        expect(ghMock).toHaveBeenCalledTimes(2);
        expect(ghMock).toHaveBeenNthCalledWith(1, [
          'issue',
          'comment',
          '248',
          '-R',
          'owner/repo',
          '--body-file',
          outputAbs('comment-248.md'),
        ]);
        expect(ghMock.mock.calls[1]?.[0]?.slice(0, 2)).toEqual(['issue', 'edit']);
        expect(ghMock.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'edit')).toBe(
          false
        );
      }
    );

    it('logs a warning and completes when the PR mirror fails during processResult', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = buildResult({ verdict: 'fail' });
      await writeOutputFile('comment-248.md', 'summary');
      ghMock
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockRejectedValueOnce(new Error('pr edit failed'));

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

      expect(ghMock).toHaveBeenNthCalledWith(2, [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:failed',
        '--remove-label',
        'shipper:pr-open',
      ]);
      expect(ghMock).toHaveBeenNthCalledWith(3, [
        'pr',
        'edit',
        '77',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:failed',
        '--remove-label',
        'shipper:pr-open',
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[shipper] Warning: Failed to mirror transition labels onto PR #77: pr edit failed'
      );

      warnSpy.mockRestore();
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

    it('retries when pr_review comment paths are outside the PR diff files', async () => {
      const repairedResult = buildResult({
        review_payload: outputRelative('review-payload-248.json'),
      });
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeOutputJson(
            'review-payload-248.json',
            buildReviewPayload({
              comments: [
                {
                  path: 'src/file.ts',
                  line: 12,
                  side: 'RIGHT',
                  body: 'Needs a test.',
                },
              ],
            })
          );
          return 0;
        });

      await writeResultFile(repairedResult);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          comments: [
            {
              path: 'src/missing.ts',
              line: 18,
              side: 'RIGHT',
              body: 'This file is not in the diff.',
            },
          ],
        })
      );

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_review',
          prFiles: new Set(['src/file.ts']),
          retry: retryMock,
        })
      ).resolves.toEqual(repairedResult);

      expect(retryMock).toHaveBeenCalledWith(
        expect.stringContaining(
          'comment path(s) not in PR diff: src/missing.ts. Valid files: src/file.ts'
        )
      );
    });

    it('retries when pr_review comments target invalid diff hunk locations', async () => {
      const repairedResult = buildResult({
        review_payload: outputRelative('review-payload-248.json'),
      });
      const diffHunks = parseDiffHunks(buildReviewDiffFixture());
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeOutputJson(
            'review-payload-248.json',
            buildReviewPayload({
              comments: [
                {
                  path: 'src/file.ts',
                  line: 12,
                  side: 'RIGHT',
                  body: 'Needs a test.',
                },
              ],
            })
          );
          return 0;
        });

      await writeResultFile(repairedResult);
      await writeOutputJson(
        'review-payload-248.json',
        buildReviewPayload({
          comments: [
            {
              path: 'src/file.ts',
              line: 45,
              side: 'RIGHT',
              body: 'This line is outside the diff hunks.',
            },
          ],
        })
      );

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_review',
          prFiles: new Set(['src/file.ts', 'src/new.ts', 'src/old.ts']),
          diffHunks,
          retry: retryMock,
        })
      ).resolves.toEqual(repairedResult);

      expect(retryMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "comments[0].line 45 (side RIGHT) is not within any diff hunk for 'src/file.ts'. Valid ranges — LEFT: 10-14, 30-30; RIGHT: 10-15, 31-31"
        )
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
