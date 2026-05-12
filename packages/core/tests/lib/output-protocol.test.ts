import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffFileHunks } from '../../src/lib/output-protocol/diff-parse.js';
import type { ResultJson } from '../../src/lib/result-schema.js';

const ghMock = vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>();

vi.mock('../../src/lib/gh.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/gh.js')>('../../src/lib/gh.js');
  return {
    ...actual,
    gh: (...args: unknown[]) => {
      return ghMock(...(args as [string[]]));
    },
  };
});

const { GhError } = await import('../../src/lib/gh.js');

const {
  createIssueFromDraft,
  createPrFromSpec,
  createPrFromSpecWithMetadata,
  PROTOCOL_INPUT_DIR,
  PROTOCOL_OUTPUT_DIR,
  executeTransition,
  formatCorrectionMessage,
  handleAgentCrash,
  postComment,
  postReplies,
  processGroomResult,
  processResult,
  parseDiffHunks,
  readNewIssueDraft,
  retryPrReviewOutputAndSubmission,
  retryOnInvalidNewIssueDraft,
  retryOnInvalidOutput,
  scrubOutputDir,
  submitReviewPayload,
  setupProtocolDirs,
  truncateLargeInput,
  validateStageOutput,
  writeContextFile,
  writeCreatedIssueResult,
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

  function makeGhError(detail: { stdout?: string; stderr?: string; code?: string | number }) {
    return new GhError(
      ['api', 'repos/owner/repo/pulls/248/reviews'],
      Object.assign(new Error(detail.stderr ?? detail.stdout ?? 'gh failed'), {
        stdout: detail.stdout ?? '',
        stderr: detail.stderr ?? '',
        ...(detail.code === undefined ? {} : { code: detail.code }),
      })
    );
  }

  function groomedBody(summary = 'Summary'): string {
    return [
      '# Summary',
      '',
      summary,
      '',
      '# Requirements',
      '',
      '1. Requirement.',
      '',
      '# Acceptance Criteria',
      '',
      '- [ ] Criterion.',
      '',
      '# Related Issues',
      '',
      'No relevant issues found.',
      '',
      '# Out of Scope',
      '',
      'None.',
      '',
      '# Open Questions',
      '',
      'None.',
    ].join('\n');
  }

  function buildGroomManifest(
    overrides: Partial<{
      parent: Record<string, unknown>;
      decomposition: Record<string, unknown>;
    }> = {}
  ) {
    return {
      parent: {
        body_file: outputRelative('issue-body-248.md'),
        priority: 'high',
        ...overrides.parent,
      },
      decomposition: {
        kind: 'none',
        children: [],
        ...overrides.decomposition,
      },
    };
  }

  function buildClosedGroomManifest(
    overrides: Partial<{
      closed: Record<string, unknown>;
      parent: Record<string, unknown>;
      decomposition: Record<string, unknown>;
    }> = {}
  ) {
    return {
      closed: {
        outcome: 'duplicate',
        duplicate_of: 347,
        ...overrides.closed,
      },
      ...(overrides.parent ? { parent: overrides.parent } : {}),
      ...(overrides.decomposition ? { decomposition: overrides.decomposition } : {}),
    };
  }

  function defaultGroomComment(manifest: Record<string, unknown>): string {
    const closed =
      typeof manifest.closed === 'object' &&
      manifest.closed !== null &&
      !Array.isArray(manifest.closed)
        ? (manifest.closed as Record<string, unknown>)
        : undefined;
    if (closed?.outcome === 'duplicate' && typeof closed.duplicate_of === 'number') {
      return `## Grooming Summary\n\nThe product owner confirmed this issue is a duplicate of #${closed.duplicate_of}.`;
    }
    if (closed?.outcome === 'not-planned' && typeof closed.rationale === 'string') {
      return `## Grooming Summary\n\n${closed.rationale}`;
    }
    return '## Grooming Summary\n\nSummary.';
  }

  async function writeValidGroomOutput(
    manifest: Record<string, unknown> = buildGroomManifest(),
    result: Partial<ResultJson> = {},
    commentText = defaultGroomComment(manifest)
  ): Promise<ResultJson> {
    const fullResult = buildResult({ groom: outputRelative('groom-248.json'), ...result });
    await writeResultFile(fullResult);
    await writeOutputFile('comment-248.md', commentText);
    await writeOutputJson('groom-248.json', manifest);

    const parent = manifest.parent;
    if (typeof parent === 'object' && parent !== null && !Array.isArray(parent)) {
      const parentRecord = parent as Record<string, unknown>;
      if (typeof parentRecord.body_file === 'string') {
        await writeOutputFile(path.basename(parentRecord.body_file), groomedBody('Parent body.'));
      }
      const parentBlocked = parentRecord.blocked as Record<string, unknown> | undefined;
      if (typeof parentBlocked?.comment_file === 'string') {
        await writeOutputFile(path.basename(parentBlocked.comment_file), '## Blocked\n\nBlocked.');
      }
    }

    const decomposition = manifest.decomposition;
    const decompositionRecord =
      typeof decomposition === 'object' && decomposition !== null && !Array.isArray(decomposition)
        ? (decomposition as Record<string, unknown>)
        : {};
    const children = Array.isArray(decompositionRecord.children)
      ? decompositionRecord.children
      : [];
    for (const [index, child] of children.entries()) {
      if (typeof child !== 'object' || child === null) {
        continue;
      }
      const childRecord = child as Record<string, unknown>;
      if (typeof childRecord.body_file === 'string') {
        await writeOutputFile(
          path.basename(childRecord.body_file),
          groomedBody(`Child ${index + 1}.`)
        );
      }
      if (typeof childRecord.grooming_comment_file === 'string') {
        await writeOutputFile(
          path.basename(childRecord.grooming_comment_file),
          `Groomed as part of #248.\n\nChild ${index + 1} context.`
        );
      }
      const blocked = childRecord.blocked as Record<string, unknown> | undefined;
      if (typeof blocked?.comment_file === 'string') {
        await writeOutputFile(
          path.basename(blocked.comment_file),
          '## Blocked\n\nBlocked until {{blocking_issue}} is done.'
        );
      }
    }
    return fullResult;
  }

  async function writeNewIssueDraft(
    opts: {
      result?: Record<string, unknown>;
      draft?: Record<string, unknown>;
      body?: string;
    } = {}
  ): Promise<void> {
    await writeResultFile({
      issue_draft: outputRelative('issue-draft.json'),
      ...opts.result,
    });
    await writeOutputJson('issue-draft.json', {
      title: 'Add generated MCP reference pages',
      body_file: outputRelative('issue-body.md'),
      ...opts.draft,
    });
    await writeOutputFile(
      'issue-body.md',
      opts.body ??
        [
          '# Request',
          '',
          'Add generated MCP reference pages.',
          '',
          '# Interpretation',
          '',
          '<!-- prettier-ignore -->',
          '*Non-binding intake interpretation: grooming may validate, revise, or discard these assumptions. The Request section remains the source of truth.*',
        ].join('\n')
    );
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

  describe('new issue draft protocol', () => {
    it('accepts a valid pre-create issue draft result', async () => {
      await writeNewIssueDraft();

      await expect(readNewIssueDraft(tempDir)).resolves.toEqual({
        title: 'Add generated MCP reference pages',
        body_file: outputRelative('issue-body.md'),
        bodyPath: outputAbs('issue-body.md'),
        issue_draft: outputRelative('issue-draft.json'),
        draftPath: outputAbs('issue-draft.json'),
        resultPath: outputAbs('result.json'),
      });
    });

    it.each([
      [
        'missing issue_draft',
        { result: { issue_draft: undefined } },
        "'issue_draft' must be a string path",
      ],
      [
        'absolute issue_draft',
        { result: { issue_draft: '/tmp/issue-draft.json' } },
        "'issue_draft' must be a relative path under .shipper/output",
      ],
      [
        'non-output issue_draft',
        { result: { issue_draft: 'issue-draft.json' } },
        "'issue_draft' must be a relative path under .shipper/output",
      ],
      [
        'old created_issue result',
        {
          result: {
            issue_draft: undefined,
            created_issue: {
              number: 42,
              title: 'Old contract',
              url: 'https://github.com/owner/repo/issues/42',
            },
          },
        },
        "result.json must not contain 'created_issue'",
      ],
      [
        'normal-stage verdict/comment result',
        {
          result: {
            verdict: 'accept',
            comment: outputRelative('comment-248.md'),
          },
        },
        "result.json must not contain 'verdict'",
      ],
    ])('rejects %s', async (_name, opts, message) => {
      await writeNewIssueDraft(opts);

      await expect(readNewIssueDraft(tempDir)).rejects.toThrow(message);
    });

    it.each([
      ['missing title', { draft: { title: undefined } }, "'title' must be a string"],
      ['blank title', { draft: { title: '   ' } }, "'title' must be a non-empty string"],
      [
        'absolute body_file',
        { draft: { body_file: '/tmp/issue-body.md' } },
        "'body_file' must be a relative path under .shipper/output",
      ],
      [
        'non-output body_file',
        { draft: { body_file: 'issue-body.md' } },
        "'body_file' must be a relative path under .shipper/output",
      ],
      [
        'agent-provided labels',
        { draft: { labels: ['shipper:new'] } },
        "'labels' is not supported; Shipper applies labels during issue creation",
      ],
      [
        'leading title heading',
        { body: '\n\n# Title\n\n# Request\n\nDo something.' },
        "issue body must not start with a '# Title' heading",
      ],
    ])('rejects draft with %s', async (_name, opts, message) => {
      await writeNewIssueDraft(opts);

      await expect(readNewIssueDraft(tempDir)).rejects.toThrow(message);
    });

    it('rejects a missing body file', async () => {
      await writeNewIssueDraft({ draft: { body_file: outputRelative('missing-body.md') } });

      await expect(readNewIssueDraft(tempDir)).rejects.toThrow(
        'issue body path does not exist or cannot be read'
      );
    });

    it('creates a GitHub issue from a validated draft and applies shipper:new', async () => {
      await writeNewIssueDraft();
      const draft = await readNewIssueDraft(tempDir);
      ghMock.mockResolvedValueOnce({
        stdout: 'https://github.com/owner/repo/issues/42\n',
        stderr: '',
      });

      await expect(createIssueFromDraft('owner/repo', draft)).resolves.toEqual({
        number: 42,
        title: 'Add generated MCP reference pages',
        url: 'https://github.com/owner/repo/issues/42',
      });

      expect(ghMock).toHaveBeenCalledWith([
        'issue',
        'create',
        '-R',
        'owner/repo',
        '--title',
        'Add generated MCP reference pages',
        '--body-file',
        outputAbs('issue-body.md'),
        '--label',
        'shipper:new',
      ]);
      await expect(readFile(outputAbs('issue-body.md'), 'utf-8')).resolves.toContain('# Request');
    });

    it('rejects issue creation output without a parseable issue number', async () => {
      await writeNewIssueDraft();
      const draft = await readNewIssueDraft(tempDir);
      ghMock.mockResolvedValueOnce({
        stdout: 'https://github.com/owner/repo/pull/42\n',
        stderr: '',
      });

      await expect(createIssueFromDraft('owner/repo', draft)).rejects.toThrow(
        'Failed to parse issue number from created issue URL'
      );
    });

    it('writes the final created_issue result', async () => {
      await expect(
        writeCreatedIssueResult(tempDir, {
          number: 42,
          title: 'Add generated MCP reference pages',
          url: 'https://github.com/owner/repo/issues/42',
        })
      ).resolves.toEqual({
        created_issue: {
          number: 42,
          title: 'Add generated MCP reference pages',
          url: 'https://github.com/owner/repo/issues/42',
        },
      });

      await expect(readFile(outputAbs('result.json'), 'utf-8')).resolves.toBe(
        `${JSON.stringify(
          {
            created_issue: {
              number: 42,
              title: 'Add generated MCP reference pages',
              url: 'https://github.com/owner/repo/issues/42',
            },
          },
          null,
          2
        )}\n`
      );
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

    it('rejects groom manifests on non-groom stages', async () => {
      await writeResultFile(buildResult({ groom: outputRelative('groom-248.json') }));

      await expect(validateStageOutput(tempDir, 'plan')).rejects.toThrow(
        'result.groom is only supported for the groom stage'
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

    it('rejects groom accepts without a manifest', async () => {
      await writeResultFile(buildResult());

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        'groom accept requires a groom manifest in result.json'
      );
    });

    it.each(['reject', 'fail'] as const)('rejects groom %s verdict output', async (verdict) => {
      await writeResultFile(buildResult({ verdict, groom: outputRelative('groom-248.json') }));

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        'groom output must use verdict accept'
      );
    });

    it('rejects invalid groom manifest state', async () => {
      await writeValidGroomOutput(
        buildGroomManifest({
          parent: { body_file: undefined },
          decomposition: { kind: 'partial', children: [] },
        })
      );

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        "'decomposition.children' must not be empty when kind is partial or full"
      );
    });

    it('accepts valid groom output', async () => {
      const result = await writeValidGroomOutput();

      await expect(validateStageOutput(tempDir, 'groom')).resolves.toEqual(result);
    });

    it('accepts a valid duplicate closed groom manifest', async () => {
      const result = await writeValidGroomOutput(buildClosedGroomManifest());

      await expect(validateStageOutput(tempDir, 'groom')).resolves.toEqual(result);
    });

    it('accepts a valid not-planned closed groom manifest', async () => {
      const result = await writeValidGroomOutput(
        buildClosedGroomManifest({
          closed: {
            outcome: 'not-planned',
            rationale: 'The product owner confirmed this work is out of scope.',
          },
        })
      );

      await expect(validateStageOutput(tempDir, 'groom')).resolves.toEqual(result);
    });

    it('rejects duplicate closed groom summaries missing the original issue reference', async () => {
      await writeValidGroomOutput(
        buildClosedGroomManifest(),
        {},
        '## Grooming Summary\n\nThe product owner confirmed this issue is a duplicate.'
      );

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        'groom comment file must reference closed.duplicate_of as #347'
      );
    });

    it('rejects not-planned closed groom summaries missing the rationale', async () => {
      await writeValidGroomOutput(
        buildClosedGroomManifest({
          closed: {
            outcome: 'not-planned',
            rationale: 'The product owner confirmed this work is out of scope.',
          },
        }),
        {},
        '## Grooming Summary\n\nClosed as not planned.'
      );

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        'groom comment file must include closed.rationale'
      );
    });

    it('rejects duplicate closed groom manifests missing the original issue reference', async () => {
      await writeValidGroomOutput(
        buildClosedGroomManifest({ closed: { duplicate_of: undefined } })
      );

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        "'closed.duplicate_of' must be a positive integer"
      );
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
    ])('rejects not-planned closed groom manifests with %s rationale', async (_name, rationale) => {
      await writeValidGroomOutput(
        buildClosedGroomManifest({
          closed: {
            outcome: 'not-planned',
            rationale,
          },
        })
      );

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        "'closed.rationale' must be a non-empty string"
      );
    });

    it('rejects closed groom manifests with an invalid outcome', async () => {
      await writeValidGroomOutput(buildClosedGroomManifest({ closed: { outcome: 'completed' } }));

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        "'closed.outcome' must be one of: duplicate, not-planned"
      );
    });

    it.each([
      [
        'parent.title',
        { parent: { title: 'Do not update the title' } },
        "'parent.title' cannot be set when 'closed' is present",
      ],
      [
        'parent.body_file',
        { parent: { body_file: outputRelative('issue-body-248.md') } },
        "'parent.body_file' cannot be set when 'closed' is present",
      ],
      [
        'parent.blocked',
        { parent: { blocked: { comment_file: outputRelative('blocked-comment-248.md') } } },
        "'parent.blocked' cannot be set when 'closed' is present",
      ],
      [
        'parent.priority',
        { parent: { priority: 'high' } },
        "'parent.priority' cannot be set when 'closed' is present",
      ],
      [
        'decomposition.kind',
        { decomposition: { kind: 'none' } },
        "'decomposition.kind' cannot be set when 'closed' is present",
      ],
      [
        'decomposition.children',
        {
          decomposition: {
            children: [
              {
                title: 'child',
                body_file: outputRelative('child-body.md'),
                grooming_comment_file: outputRelative('child-comment.md'),
              },
            ],
          },
        },
        "'decomposition.children' must be empty or omitted when 'closed' is present",
      ],
    ])(
      'rejects closed groom manifests that also set %s',
      async (_field, overrides, expectedError) => {
        await writeValidGroomOutput(buildClosedGroomManifest(overrides));

        await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(expectedError);
      }
    );

    it('rejects groom output when the top-level comment file is missing', async () => {
      await writeValidGroomOutput();
      await rm(outputAbs('comment-248.md'));

      await expect(validateStageOutput(tempDir, 'groom')).rejects.toThrow(
        'groom comment file does not exist or cannot be read'
      );
      expect(ghMock).not.toHaveBeenCalled();
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
    it('rejects groom results before any gh call', async () => {
      const result = buildResult({ groom: outputRelative('groom-248.json') });

      await expect(
        processResult({
          repo: 'owner/repo',
          issueNumber: '248',
          stage: 'groom',
          cwd: tempDir,
          result,
        })
      ).rejects.toThrow('groom results must be processed with processGroomResult');

      expect(ghMock).not.toHaveBeenCalled();
    });

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

    it('skips duplicate review submission when the payload was already submitted', async () => {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      await writeOutputFile('comment-248.md', 'summary');
      await writeOutputJson('review-payload-248.json', buildReviewPayload());

      await expect(
        processResult({
          repo: 'owner/repo',
          issueNumber: '248',
          stage: 'pr_review',
          cwd: tempDir,
          result,
          prNumber: '77',
          reviewPayloadAlreadySubmitted: true,
        })
      ).resolves.toEqual(result);

      expect(ghMock).toHaveBeenCalledTimes(3);
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
        'shipper:pr-reviewed',
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
        'shipper:pr-reviewed',
        '--remove-label',
        'shipper:pr-open',
      ]);
      expect(
        ghMock.mock.calls.some(([args]) => args[0] === 'api' && args.includes('--input'))
      ).toBe(false);
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

  describe('processGroomResult', () => {
    it('rewrites the parent, posts the summary, and applies labels last for no decomposition', async () => {
      const result = await writeValidGroomOutput();

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).resolves.toEqual(result);

      expect(ghMock).toHaveBeenNthCalledWith(1, [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--body-file',
        outputAbs('issue-body-248.md'),
      ]);
      expect(ghMock).toHaveBeenNthCalledWith(2, [
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body-file',
        outputAbs('comment-248.md'),
      ]);
      expect(ghMock).toHaveBeenNthCalledWith(3, [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:groomed',
        '--add-label',
        'shipper:priority-high',
        '--remove-label',
        'shipper:new',
        '--remove-label',
        'shipper:priority-low',
        '--remove-label',
        'shipper:blocked',
      ]);
    });

    it('rejects missing top-level groom comments before any GitHub writes', async () => {
      const result = await writeValidGroomOutput();
      await rm(outputAbs('comment-248.md'));

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).rejects.toThrow('ENOENT');
      expect(ghMock).not.toHaveBeenCalled();
    });

    it('rejects invalid closed groom manifests before any GitHub writes', async () => {
      const result = await writeValidGroomOutput(
        buildClosedGroomManifest({ parent: { priority: 'high' } })
      );

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).rejects.toThrow("'parent.priority' cannot be set when 'closed' is present");
      expect(ghMock).not.toHaveBeenCalled();
    });

    it('rejects closed duplicate groom summaries before any GitHub writes', async () => {
      const result = await writeValidGroomOutput(
        buildClosedGroomManifest(),
        {},
        '## Grooming Summary\n\nClosed as duplicate.'
      );

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).rejects.toThrow('groom comment file must reference closed.duplicate_of as #347');
      expect(ghMock).not.toHaveBeenCalled();
    });

    it('rejects closed not-planned groom summaries before any GitHub writes', async () => {
      const result = await writeValidGroomOutput(
        buildClosedGroomManifest({
          closed: {
            outcome: 'not-planned',
            rationale: 'The product owner confirmed this work is out of scope.',
          },
        }),
        {},
        '## Grooming Summary\n\nClosed as not planned.'
      );

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).rejects.toThrow('groom comment file must include closed.rationale');
      expect(ghMock).not.toHaveBeenCalled();
    });

    it('posts duplicate closed groom summaries before closing and removing labels', async () => {
      const result = await writeValidGroomOutput(buildClosedGroomManifest());

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
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
        'close',
        '248',
        '-R',
        'owner/repo',
        '--duplicate-of',
        '347',
      ]);
      expect(ghMock).toHaveBeenNthCalledWith(3, [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--remove-label',
        'shipper:new',
        '--remove-label',
        'shipper:priority-high',
        '--remove-label',
        'shipper:priority-low',
        '--remove-label',
        'shipper:blocked',
      ]);
      expect(ghMock.mock.calls.flatMap(([args]) => args)).not.toContain('shipper:groomed');
    });

    it('posts not-planned closed groom summaries before closing and removing labels', async () => {
      const result = await writeValidGroomOutput(
        buildClosedGroomManifest({
          closed: {
            outcome: 'not-planned',
            rationale: 'The product owner confirmed this work is out of scope.',
          },
        })
      );

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
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
        'close',
        '248',
        '-R',
        'owner/repo',
        '--reason',
        'not planned',
      ]);
      expect(ghMock).toHaveBeenNthCalledWith(3, [
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--remove-label',
        'shipper:new',
        '--remove-label',
        'shipper:priority-high',
        '--remove-label',
        'shipper:priority-low',
        '--remove-label',
        'shipper:blocked',
      ]);
      expect(ghMock.mock.calls.flatMap(([args]) => args)).not.toContain('shipper:groomed');
    });

    it('posts a groom post-flight failure comment when closed groom close fails', async () => {
      const result = await writeValidGroomOutput(buildClosedGroomManifest());
      ghMock
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockRejectedValueOnce(new Error('close failed'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).rejects.toThrow('Groom post-flight failed');

      expect(ghMock.mock.calls.some(([args]) => args[0] === 'issue' && args[1] === 'edit')).toBe(
        false
      );
      expect(ghMock.mock.calls.at(-1)?.[0]).toEqual([
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body',
        expect.stringContaining('## Groom Post-flight Failure'),
      ]);
      const failureBody = ghMock.mock.calls.at(-1)?.[0]?.at(-1);
      expect(failureBody).toEqual(expect.stringContaining('post parent grooming summary'));
      expect(failureBody).toEqual(expect.stringContaining('close parent issue: close failed'));
      expect(failureBody).toEqual(
        expect.stringContaining('remove closed parent labels: close parent issue failed')
      );
    });

    it('creates full-replacement children, posts scoped comments, and closes the parent', async () => {
      const result = await writeValidGroomOutput(
        buildGroomManifest({
          parent: { body_file: undefined, priority: 'normal' },
          decomposition: {
            kind: 'full',
            children: [
              {
                title: 'feat: child one',
                body_file: outputRelative('child-1-body.md'),
                grooming_comment_file: outputRelative('child-1-comment.md'),
              },
              {
                title: 'feat: child two',
                body_file: outputRelative('child-2-body.md'),
                grooming_comment_file: outputRelative('child-2-comment.md'),
                blocked: {
                  depends_on_child_index: 0,
                  comment_file: outputRelative('child-2-blocked.md'),
                },
              },
            ],
          },
        })
      );
      ghMock
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/issues/301\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/issues/302\n', stderr: '' })
        .mockResolvedValue({ stdout: '', stderr: '' });

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).resolves.toEqual(result);

      expect(ghMock.mock.calls[1]?.[0]).toEqual([
        'issue',
        'create',
        '-R',
        'owner/repo',
        '--title',
        'feat: child one',
        '--body-file',
        outputAbs('child-1-body.md'),
        '--label',
        'shipper:groomed',
      ]);
      expect(ghMock.mock.calls[2]?.[0]).toContain('shipper:blocked');
      expect(ghMock.mock.calls.some(([args]) => args.some((arg) => arg.includes('#301')))).toBe(
        true
      );
      expect(ghMock.mock.calls.at(-1)?.[0]?.slice(0, 4)).toEqual(['issue', 'close', '248', '-R']);
      expect(ghMock.mock.calls.some(([args]) => args[0] === 'issue' && args[1] === 'edit')).toBe(
        false
      );
    });

    it('keeps the full-replacement parent open when an earlier post-flight write fails', async () => {
      const result = await writeValidGroomOutput(
        buildGroomManifest({
          parent: { body_file: undefined, priority: 'normal' },
          decomposition: {
            kind: 'full',
            children: [
              {
                title: 'feat: child one',
                body_file: outputRelative('child-1-body.md'),
                grooming_comment_file: outputRelative('child-1-comment.md'),
              },
              {
                title: 'feat: child two',
                body_file: outputRelative('child-2-body.md'),
                grooming_comment_file: outputRelative('child-2-comment.md'),
              },
            ],
          },
        })
      );
      ghMock.mockImplementation((args) => {
        if (args[0] === 'issue' && args[1] === 'create') {
          return Promise.resolve({
            stdout: args.includes('feat: child one')
              ? 'https://github.com/owner/repo/issues/301\n'
              : 'https://github.com/owner/repo/issues/302\n',
            stderr: '',
          });
        }
        if (args[0] === 'issue' && args[1] === 'comment' && args[2] === '301') {
          return Promise.reject(new Error('child comment failed'));
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).rejects.toThrow('Groom post-flight failed');

      expect(ghMock.mock.calls.some(([args]) => args[0] === 'issue' && args[1] === 'close')).toBe(
        false
      );
      expect(ghMock.mock.calls.at(-1)?.[0]).toEqual([
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body',
        expect.stringContaining(
          'close parent issue: one or more earlier post-flight operations failed'
        ),
      ]);
    });

    it('posts one failure comment and skips parent label transition after partial failure', async () => {
      const result = await writeValidGroomOutput();
      ghMock
        .mockRejectedValueOnce(new Error('body update failed'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).rejects.toThrow('body update failed');

      expect(
        ghMock.mock.calls.some(
          ([args]) => args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label')
        )
      ).toBe(false);
      expect(ghMock.mock.calls.at(-1)?.[0]).toEqual([
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body',
        expect.stringContaining('## Groom Post-flight Failure'),
      ]);
    });

    it('truncates oversized groom post-flight failure comments', async () => {
      const result = await writeValidGroomOutput();
      const largeDetail = Array.from(
        { length: 140 },
        (_, index) => `${'x'.repeat(400)} groom failure line ${index + 1}`
      ).join('\n');
      ghMock
        .mockRejectedValueOnce(new Error(largeDetail))
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).rejects.toThrow('groom failure line 140');

      expect(ghMock.mock.calls.at(-1)?.[0]).toEqual([
        'issue',
        'comment',
        '248',
        '-R',
        'owner/repo',
        '--body',
        expect.stringContaining(
          'full output written to .shipper/input/groom-post-flight-failure.txt'
        ),
      ]);
      await expect(
        readFile(path.join(tempDir, PROTOCOL_INPUT_DIR, 'groom-post-flight-failure.txt'), 'utf-8')
      ).resolves.toContain(largeDetail);
    });

    it('applies blocked parent state and creates partial-replacement children', async () => {
      const result = await writeValidGroomOutput(
        buildGroomManifest({
          parent: {
            priority: 'low',
            blocked: { comment_file: outputRelative('parent-blocked.md') },
          },
          decomposition: {
            kind: 'partial',
            children: [
              {
                title: 'feat: child',
                body_file: outputRelative('child-body.md'),
                grooming_comment_file: outputRelative('child-comment.md'),
              },
            ],
          },
        })
      );
      ghMock
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/issues/301\n', stderr: '' })
        .mockResolvedValue({ stdout: '', stderr: '' });

      await expect(
        processGroomResult({ repo: 'owner/repo', issueNumber: '248', cwd: tempDir, result })
      ).resolves.toEqual(result);

      expect(ghMock.mock.calls.some(([args]) => args[0] === 'issue' && args[1] === 'create')).toBe(
        true
      );
      expect(
        ghMock.mock.calls.some(([args]) => args.includes(outputAbs('parent-blocked.md')))
      ).toBe(true);
      expect(ghMock.mock.calls.at(-1)?.[0]).toEqual([
        'issue',
        'edit',
        '248',
        '-R',
        'owner/repo',
        '--add-label',
        'shipper:groomed',
        '--add-label',
        'shipper:priority-low',
        '--add-label',
        'shipper:blocked',
        '--remove-label',
        'shipper:new',
        '--remove-label',
        'shipper:priority-high',
      ]);
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

      expect(retryMock).toHaveBeenCalledTimes(1);
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

      expect(retryMock).toHaveBeenCalledTimes(1);
    });

    it('returns the third attempt output and refreshes correction messages for pr_open errors', async () => {
      const repairedResult = buildResult({ pr_spec: outputRelative('pr-spec-248.json') });
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          if (retryMock.mock.calls.length === 1) {
            await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
            const invalidSpec = buildPrSpec();
            delete (invalidSpec as Partial<typeof invalidSpec>).title;
            await writeOutputJson('pr-spec-248.json', invalidSpec);
            return 0;
          }

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

      expect(retryMock).toHaveBeenCalledTimes(2);
      expect(retryMock.mock.calls[1]?.[0]).toContain("- 'title' must be a string");
      expect(retryMock.mock.calls[1]?.[0]).not.toContain(
        'pr_open accept requires a pr_spec in result.json'
      );
    });

    it('returns the third attempt output and refreshes correction messages for pr_review errors', async () => {
      const repairedResult = buildResult({
        review_payload: outputRelative('review-payload-248.json'),
      });
      const diffHunks = parseDiffHunks(buildReviewDiffFixture());
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeResultFile(repairedResult);

          if (retryMock.mock.calls.length === 1) {
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
            return 0;
          }

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
      await writeOutputFile('result.json', '{invalid');

      await expect(
        retryOnInvalidOutput({
          cwd: tempDir,
          stage: 'pr_review',
          prFiles: new Set(['src/file.ts', 'src/new.ts', 'src/old.ts']),
          diffHunks,
          retry: retryMock,
        })
      ).resolves.toEqual(repairedResult);

      expect(retryMock).toHaveBeenCalledTimes(2);
      expect(retryMock.mock.calls[1]?.[0]).toContain(
        "comments[0].line 45 (side RIGHT) is not within any diff hunk for 'src/file.ts'"
      );
      expect(retryMock.mock.calls[1]?.[0]).not.toContain('Failed to parse ');
    });

    it('accepts a third-attempt repair after a non-zero retry exit code', async () => {
      const repairedResult = buildResult({ pr_spec: outputRelative('pr-spec-248.json') });
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          if (retryMock.mock.calls.length === 1) {
            await writeResultFile(buildResult({ pr_spec: outputRelative('pr-spec-248.json') }));
            const invalidSpec = buildPrSpec();
            delete (invalidSpec as Partial<typeof invalidSpec>).title;
            await writeOutputJson('pr-spec-248.json', invalidSpec);
            return 17;
          }

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

      expect(retryMock).toHaveBeenCalledTimes(2);
    });

    it('rethrows the final validation error when all retries still produce invalid output', async () => {
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

      expect(retryMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('retryOnInvalidNewIssueDraft', () => {
    it('does not retry when output is already valid', async () => {
      const retryMock = vi.fn<(message: string) => Promise<number>>().mockResolvedValue(1);
      await writeNewIssueDraft();

      await expect(
        retryOnInvalidNewIssueDraft({
          cwd: tempDir,
          retry: retryMock,
        })
      ).resolves.toEqual({
        title: 'Add generated MCP reference pages',
        body_file: outputRelative('issue-body.md'),
        bodyPath: outputAbs('issue-body.md'),
        issue_draft: outputRelative('issue-draft.json'),
        draftPath: outputAbs('issue-draft.json'),
        resultPath: outputAbs('result.json'),
      });

      expect(retryMock).not.toHaveBeenCalled();
    });

    it('returns the revalidated draft after retry repairs it', async () => {
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeNewIssueDraft();
          return 0;
        });
      await writeResultFile({});

      await expect(
        retryOnInvalidNewIssueDraft({
          cwd: tempDir,
          retry: retryMock,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          title: 'Add generated MCP reference pages',
          bodyPath: outputAbs('issue-body.md'),
        })
      );

      expect(retryMock).toHaveBeenCalledTimes(1);
      expect(retryMock).toHaveBeenCalledWith(
        expect.stringContaining(
          'Your previous output was invalid. Fix the following and produce a valid .shipper/output/result.json:'
        )
      );
    });

    it('refreshes correction messages on the second invalid draft', async () => {
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          if (retryMock.mock.calls.length === 1) {
            await writeNewIssueDraft({ draft: { title: '' } });
            return 0;
          }

          await writeNewIssueDraft();
          return 0;
        });
      await writeOutputFile('result.json', '{invalid');

      await expect(
        retryOnInvalidNewIssueDraft({
          cwd: tempDir,
          retry: retryMock,
        })
      ).resolves.toEqual(expect.objectContaining({ title: 'Add generated MCP reference pages' }));

      expect(retryMock).toHaveBeenCalledTimes(2);
      expect(retryMock.mock.calls[1]?.[0]).toContain("'title' must be a non-empty string");
      expect(retryMock.mock.calls[1]?.[0]).not.toContain('Failed to parse');
    });

    it('accepts valid retry output even when the retry exit code is non-zero', async () => {
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeNewIssueDraft();
          return 17;
        });
      await writeResultFile({});

      await expect(
        retryOnInvalidNewIssueDraft({
          cwd: tempDir,
          retry: retryMock,
        })
      ).resolves.toEqual(expect.objectContaining({ title: 'Add generated MCP reference pages' }));

      expect(retryMock).toHaveBeenCalledTimes(1);
    });

    it('rethrows the final validation error after the third attempt', async () => {
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeNewIssueDraft({ draft: { title: '' } });
          return 0;
        });
      await writeResultFile({});

      await expect(
        retryOnInvalidNewIssueDraft({
          cwd: tempDir,
          retry: retryMock,
        })
      ).rejects.toThrow("'title' must be a non-empty string");

      expect(retryMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('retryPrReviewOutputAndSubmission', () => {
    async function writePrReviewResult(
      payloadOverrides: Parameters<typeof buildReviewPayload>[0] = {}
    ): Promise<ResultJson> {
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      await writeResultFile(result);
      await writeOutputJson('review-payload-248.json', buildReviewPayload(payloadOverrides));
      return result;
    }

    it('retries a recoverable GitHub review rejection after refreshing context', async () => {
      const result = await writePrReviewResult({
        comments: [{ path: 'src/old.ts', line: 4, side: 'RIGHT', body: 'Old context.' }],
      });
      const githubBody =
        '{"message":"Validation Failed","errors":[{"message":"line must be part of the diff"}]}';
      const events: string[] = [];
      const submitReviewPayloadMock = vi
        .fn<(payloadPath: string) => Promise<void>>()
        .mockImplementationOnce(() => {
          events.push('submit failed');
          return Promise.reject(
            makeGhError({
              stderr: 'gh: Validation Failed (HTTP 422)',
              stdout: githubBody,
            })
          );
        })
        .mockImplementationOnce(() => {
          events.push('submit succeeded');
          return Promise.resolve();
        });
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async (message) => {
          events.push('retry');
          expect(message).toContain(githubBody);
          await writeOutputJson(
            'review-payload-248.json',
            buildReviewPayload({
              comments: [{ path: 'src/new.ts', line: 12, side: 'RIGHT', body: 'New context.' }],
            })
          );
          return 0;
        });
      const refreshContextMock = vi.fn(() => {
        events.push('refresh');
        return Promise.resolve({ prFiles: new Set(['src/new.ts']) });
      });

      await expect(
        retryPrReviewOutputAndSubmission({
          cwd: tempDir,
          prFiles: new Set(['src/old.ts']),
          retry: retryMock,
          submitReviewPayload: submitReviewPayloadMock,
          refreshContext: refreshContextMock,
        })
      ).resolves.toEqual({ result, reviewSubmitted: true });

      expect(events).toEqual(['submit failed', 'refresh', 'retry', 'submit succeeded']);
      expect(submitReviewPayloadMock).toHaveBeenCalledTimes(2);
      expect(submitReviewPayloadMock).toHaveBeenCalledWith(
        outputRelative('review-payload-248.json')
      );
      expect(refreshContextMock).toHaveBeenCalledTimes(1);
      expect(retryMock).toHaveBeenCalledTimes(1);
    });

    it('preserves existing review diff hunks when refreshed context omits them', async () => {
      const result = await writePrReviewResult({
        comments: [{ path: 'src/file.ts', line: 5, side: 'RIGHT', body: 'Initial.' }],
      });
      const submitReviewPayloadMock = vi
        .fn<(payloadPath: string) => Promise<void>>()
        .mockRejectedValueOnce(
          makeGhError({
            stderr: 'gh: Validation Failed (HTTP 422)',
            stdout: '{"message":"Validation Failed","errors":[{"message":"stale commit_id"}]}',
          })
        )
        .mockResolvedValueOnce(undefined);
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementationOnce(async (message) => {
          expect(message).toContain('stale commit_id');
          await writeOutputJson(
            'review-payload-248.json',
            buildReviewPayload({
              comments: [{ path: 'src/file.ts', line: 99, side: 'RIGHT', body: 'Out of hunk.' }],
            })
          );
          return 0;
        })
        .mockImplementationOnce(async (message) => {
          expect(message).toContain('line 99');
          await writeOutputJson(
            'review-payload-248.json',
            buildReviewPayload({
              comments: [{ path: 'src/file.ts', line: 5, side: 'RIGHT', body: 'Fixed.' }],
            })
          );
          return 0;
        });
      const refreshContextMock = vi.fn(() =>
        Promise.resolve({ prFiles: new Set(['src/file.ts']) })
      );

      await expect(
        retryPrReviewOutputAndSubmission({
          cwd: tempDir,
          prFiles: new Set(['src/file.ts']),
          diffHunks: new Map<string, DiffFileHunks>([
            [
              'src/file.ts',
              {
                left: [],
                right: [[5, 5]],
              },
            ],
          ]),
          retry: retryMock,
          submitReviewPayload: submitReviewPayloadMock,
          refreshContext: refreshContextMock,
        })
      ).resolves.toEqual({ result, reviewSubmitted: true });

      expect(refreshContextMock).toHaveBeenCalledTimes(1);
      expect(retryMock).toHaveBeenCalledTimes(2);
      expect(submitReviewPayloadMock).toHaveBeenCalledTimes(2);
    });

    it('shares one three-attempt budget across local validation failures and GitHub rejections', async () => {
      await writeResultFile(buildResult());
      const result = buildResult({ review_payload: outputRelative('review-payload-248.json') });
      const submitReviewPayloadMock = vi
        .fn<(payloadPath: string) => Promise<void>>()
        .mockRejectedValueOnce(
          makeGhError({
            stderr: 'gh: Validation Failed (HTTP 422)',
            stdout: '{"message":"Validation Failed","errors":[{"message":"stale commit_id"}]}',
          })
        )
        .mockResolvedValueOnce(undefined);
      const retryMock = vi
        .fn<(message: string) => Promise<number>>()
        .mockImplementation(async () => {
          await writeResultFile(result);
          await writeOutputJson('review-payload-248.json', buildReviewPayload());
          return 0;
        });

      await expect(
        retryPrReviewOutputAndSubmission({
          cwd: tempDir,
          retry: retryMock,
          submitReviewPayload: submitReviewPayloadMock,
        })
      ).resolves.toEqual({ result, reviewSubmitted: true });

      expect(retryMock).toHaveBeenCalledTimes(2);
      expect(retryMock.mock.calls[0]?.[0]).toContain(
        'pr_review accept requires a review_payload in result.json'
      );
      expect(retryMock.mock.calls[1]?.[0]).toContain('stale commit_id');
      expect(submitReviewPayloadMock).toHaveBeenCalledTimes(2);
    });

    it('rethrows the most recent GitHub rejection when the shared budget is exhausted', async () => {
      await writePrReviewResult();
      const submitReviewPayloadMock = vi
        .fn<(payloadPath: string) => Promise<void>>()
        .mockRejectedValueOnce(
          makeGhError({
            stderr: 'gh: Validation Failed (HTTP 422)',
            stdout: '{"message":"old rejection"}',
          })
        )
        .mockRejectedValueOnce(
          makeGhError({
            stderr: 'gh: Validation Failed (HTTP 422)',
            stdout: '{"message":"middle rejection"}',
          })
        )
        .mockRejectedValueOnce(
          makeGhError({
            stderr: 'gh: Validation Failed (HTTP 422)',
            stdout: '{"message":"latest rejection"}',
          })
        );
      const retryMock = vi.fn<(message: string) => Promise<number>>().mockResolvedValue(0);

      await expect(
        retryPrReviewOutputAndSubmission({
          cwd: tempDir,
          retry: retryMock,
          submitReviewPayload: submitReviewPayloadMock,
        })
      ).rejects.toThrow('latest rejection');

      expect(submitReviewPayloadMock).toHaveBeenCalledTimes(3);
      expect(retryMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-fixable GitHub review submission failures', async () => {
      await writePrReviewResult();
      const submitReviewPayloadMock = vi
        .fn<(payloadPath: string) => Promise<void>>()
        .mockRejectedValue(
          makeGhError({
            stderr: 'gh: Bad credentials (HTTP 401)',
            stdout: '{"message":"Bad credentials"}',
          })
        );
      const retryMock = vi.fn<(message: string) => Promise<number>>().mockResolvedValue(0);
      const refreshContextMock = vi.fn(() =>
        Promise.resolve({ prFiles: new Set(['src/file.ts']) })
      );

      await expect(
        retryPrReviewOutputAndSubmission({
          cwd: tempDir,
          retry: retryMock,
          submitReviewPayload: submitReviewPayloadMock,
          refreshContext: refreshContextMock,
        })
      ).rejects.toThrow('Bad credentials');

      expect(submitReviewPayloadMock).toHaveBeenCalledTimes(1);
      expect(retryMock).not.toHaveBeenCalled();
      expect(refreshContextMock).not.toHaveBeenCalled();
    });

    it('truncates oversized GitHub rejection detail in correction messages', async () => {
      await writePrReviewResult();
      const oversizedBody = JSON.stringify({
        message: 'Validation Failed',
        detail: 'x'.repeat(60_000),
      });
      const submitReviewPayloadMock = vi
        .fn<(payloadPath: string) => Promise<void>>()
        .mockRejectedValueOnce(
          makeGhError({
            stderr: 'gh: Validation Failed (HTTP 422)',
            stdout: oversizedBody,
          })
        )
        .mockResolvedValueOnce(undefined);
      const retryMock = vi.fn<(message: string) => Promise<number>>().mockResolvedValue(0);

      await expect(
        retryPrReviewOutputAndSubmission({
          cwd: tempDir,
          retry: retryMock,
          submitReviewPayload: submitReviewPayloadMock,
        })
      ).resolves.toEqual({
        result: buildResult({ review_payload: outputRelative('review-payload-248.json') }),
        reviewSubmitted: true,
      });

      expect(retryMock).toHaveBeenCalledTimes(1);
      expect(retryMock.mock.calls[0]?.[0]).toContain(
        'full output written to .shipper/input/github-review-rejection.txt'
      );
      await expect(
        readFile(path.join(tempDir, PROTOCOL_INPUT_DIR, 'github-review-rejection.txt'), 'utf-8')
      ).resolves.toContain(oversizedBody);
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

  it('truncates oversized crash details in the posted failure comment when cwd is provided', async () => {
    const detail = Array.from(
      { length: 140 },
      (_, index) => `${'x'.repeat(400)} line ${index + 1}`
    ).join('\n');

    await handleAgentCrash('owner/repo', '248', 'implement', detail, undefined, {
      cwd: tempDir,
      detailFilename: 'implement-failure-detail.txt',
    });

    expect(ghMock).toHaveBeenCalledTimes(1);
    const postedBody = ghMock.mock.calls[0]?.[0]?.at(-1);
    expect(postedBody).toContain('## Agent Failure');
    expect(postedBody).toContain(
      '[40 lines omitted; full output written to .shipper/input/implement-failure-detail.txt]'
    );
    await expect(
      readFile(path.join(tempDir, PROTOCOL_INPUT_DIR, 'implement-failure-detail.txt'), 'utf-8')
    ).resolves.toBe(detail);
  });
});
