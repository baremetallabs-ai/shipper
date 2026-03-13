import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidResultError,
  MissingResultFileError,
  parsePrSpec,
  parseReplies,
  parseReviewPayload,
  resolveOutputPath,
  validateResult,
  validateResultFiles,
} from '../../src/lib/result-schema.js';

const tempDirs: string[] = [];

async function createOutputDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shipper-result-schema-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) =>
        import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))
      )
  );
});

describe('validateResult', () => {
  it('accepts all three verdicts', () => {
    expect(validateResult('{"verdict":"accept","comment":"comment.md"}')).toEqual({
      verdict: 'accept',
      comment: 'comment.md',
    });
    expect(validateResult('{"verdict":"reject","comment":"comment.md"}')).toEqual({
      verdict: 'reject',
      comment: 'comment.md',
    });
    expect(validateResult('{"verdict":"fail","comment":"comment.md"}')).toEqual({
      verdict: 'fail',
      comment: 'comment.md',
    });
  });

  it('rejects malformed JSON', () => {
    expect(() => validateResult('{')).toThrowError(InvalidResultError);
    expect(() => validateResult('{')).toThrow(/invalid JSON/i);
  });

  it('rejects missing comment and wrong field types', () => {
    expect(() => validateResult({ verdict: 'accept' })).toThrow(/result.comment/i);
    expect(() => validateResult({ verdict: 'accept', comment: 'ok.md', pr_spec: 42 })).toThrow(
      /result.pr_spec must be a string/i
    );
  });

  it('rejects unsupported verdict values', () => {
    expect(() => validateResult({ verdict: 'maybe', comment: 'comment.md' })).toThrow(
      /must be one of/i
    );
  });
});

describe('resolveOutputPath', () => {
  it('rejects absolute paths and traversal', async () => {
    const outputDir = await createOutputDir();
    expect(() => resolveOutputPath(outputDir, '/tmp/comment.md')).toThrow(/relative/i);
    expect(() => resolveOutputPath(outputDir, '../comment.md')).toThrow(/within .shipper\/output/i);
  });
});

describe('validateResultFiles', () => {
  it('rejects missing referenced files and directories', async () => {
    const outputDir = await createOutputDir();
    await writeFile(path.join(outputDir, 'comment.md'), 'comment\n', 'utf-8');

    await expect(
      validateResultFiles(outputDir, {
        verdict: 'accept',
        comment: 'comment.md',
        pr_spec: 'missing.json',
      })
    ).rejects.toThrowError(MissingResultFileError);

    await expect(
      validateResultFiles(outputDir, {
        verdict: 'accept',
        comment: 'comment.md',
        replies: 'missing-dir',
      })
    ).rejects.toThrow(/Replies directory/i);
  });

  it('accepts present referenced files', async () => {
    const outputDir = await createOutputDir();
    await writeFile(path.join(outputDir, 'comment.md'), 'comment\n', 'utf-8');
    await writeFile(path.join(outputDir, 'spec.json'), '{}', 'utf-8');
    await writeFile(path.join(outputDir, 'review.json'), '{}', 'utf-8');
    await mkdir(path.join(outputDir, 'replies'));

    await expect(
      validateResultFiles(outputDir, {
        verdict: 'accept',
        comment: 'comment.md',
        pr_spec: 'spec.json',
        review_payload: 'review.json',
        replies: 'replies',
      })
    ).resolves.toBeUndefined();
  });
});

describe('stage-specific payload parsers', () => {
  it('parses pr_open spec and enforces body path confinement', async () => {
    const outputDir = await createOutputDir();
    await writeFile(path.join(outputDir, 'comment.md'), 'comment\n', 'utf-8');
    await writeFile(path.join(outputDir, 'body.md'), 'PR body\n', 'utf-8');
    await writeFile(
      path.join(outputDir, 'pr-spec.json'),
      JSON.stringify({ title: 'feat: protocol', base: 'main', body: 'body.md', draft: true }),
      'utf-8'
    );

    await expect(
      parsePrSpec(outputDir, {
        verdict: 'accept',
        comment: 'comment.md',
        pr_spec: 'pr-spec.json',
      })
    ).resolves.toEqual({
      title: 'feat: protocol',
      base: 'main',
      body: 'body.md',
      draft: true,
    });

    await writeFile(
      path.join(outputDir, 'bad-pr-spec.json'),
      JSON.stringify({ title: 'x', base: 'main', body: '../escape.md' }),
      'utf-8'
    );

    await expect(
      parsePrSpec(outputDir, {
        verdict: 'accept',
        comment: 'comment.md',
        pr_spec: 'bad-pr-spec.json',
      })
    ).rejects.toThrow(/within .shipper\/output/i);
  });

  it('parses review payloads and rejects invalid events', async () => {
    const outputDir = await createOutputDir();
    await writeFile(path.join(outputDir, 'comment.md'), 'comment\n', 'utf-8');
    await writeFile(
      path.join(outputDir, 'review.json'),
      JSON.stringify({
        commit_id: 'abc123',
        body: 'Looks good',
        event: 'REQUEST_CHANGES',
        comments: [{ path: 'src/file.ts', line: 7, side: 'RIGHT', body: 'Fix this' }],
      }),
      'utf-8'
    );

    const parsed = await parseReviewPayload(outputDir, {
      verdict: 'accept',
      comment: 'comment.md',
      review_payload: 'review.json',
    });
    expect(parsed.payload.event).toBe('REQUEST_CHANGES');
    expect(parsed.payload.comments).toHaveLength(1);

    await writeFile(
      path.join(outputDir, 'bad-review.json'),
      JSON.stringify({ commit_id: 'abc123', body: 'nope', event: 'BLOCK' }),
      'utf-8'
    );

    await expect(
      parseReviewPayload(outputDir, {
        verdict: 'accept',
        comment: 'comment.md',
        review_payload: 'bad-review.json',
      })
    ).rejects.toThrow(/must be one of/i);
  });

  it('parses reply directories keyed by numeric comment ID', async () => {
    const outputDir = await createOutputDir();
    await writeFile(path.join(outputDir, 'comment.md'), 'comment\n', 'utf-8');
    await mkdir(path.join(outputDir, 'replies'));
    await writeFile(path.join(outputDir, 'replies', '10'), 'Reply ten\n', 'utf-8');
    await writeFile(path.join(outputDir, 'replies', '2'), 'Reply two\n', 'utf-8');

    await expect(
      parseReplies(outputDir, {
        verdict: 'accept',
        comment: 'comment.md',
        replies: 'replies',
      })
    ).resolves.toEqual([
      { commentId: '2', path: path.join(outputDir, 'replies', '2') },
      { commentId: '10', path: path.join(outputDir, 'replies', '10') },
    ]);

    await writeFile(path.join(outputDir, 'replies', 'abc.md'), 'bad\n', 'utf-8');
    await expect(
      parseReplies(outputDir, {
        verdict: 'accept',
        comment: 'comment.md',
        replies: 'replies',
      })
    ).rejects.toThrow(/numeric review comment IDs/i);
  });
});
