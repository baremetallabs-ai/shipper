import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readResultFile,
  ResultValidationError,
  validateResult,
} from '../../src/lib/result-schema.js';

describe('validateResult', () => {
  it.each(['accept', 'reject', 'fail'] as const)('accepts a valid %s verdict result', (verdict) => {
    expect(
      validateResult({
        verdict,
        comment: '.shipper/output/comment-248.md',
      })
    ).toEqual({
      verdict,
      comment: '.shipper/output/comment-248.md',
    });
  });

  it('accepts optional payload paths', () => {
    expect(
      validateResult({
        verdict: 'accept',
        comment: '.shipper/output/comment-248.md',
        pr_spec: '.shipper/output/pr-spec.json',
        review_payload: '.shipper/output/review.json',
        replies: '.shipper/output/replies',
        groom: '.shipper/output/groom-248.json',
      })
    ).toEqual({
      verdict: 'accept',
      comment: '.shipper/output/comment-248.md',
      pr_spec: '.shipper/output/pr-spec.json',
      review_payload: '.shipper/output/review.json',
      replies: '.shipper/output/replies',
      groom: '.shipper/output/groom-248.json',
    });
  });

  it('ignores extra fields', () => {
    expect(
      validateResult({
        verdict: 'accept',
        comment: '.shipper/output/comment-248.md',
        ignored: true,
      })
    ).toEqual({
      verdict: 'accept',
      comment: '.shipper/output/comment-248.md',
    });
  });

  it('rejects non-object input', () => {
    expect(() => validateResult('bad')).toThrowError(
      new ResultValidationError(['result.json must be a JSON object'])
    );
  });

  it('rejects null input', () => {
    expect(() => validateResult(null)).toThrowError(
      new ResultValidationError(['result.json must be a JSON object'])
    );
  });

  it('reports every missing required field', () => {
    expect(() => validateResult({})).toThrowError(
      "Invalid result.json:\n- missing required field 'verdict'\n- missing required field 'comment'"
    );
  });

  it('rejects an invalid verdict value', () => {
    expect(() =>
      validateResult({
        verdict: 'approved',
        comment: '.shipper/output/comment-248.md',
      })
    ).toThrowError(
      "Invalid result.json:\n- 'verdict' must be one of: accept, reject, fail (got 'approved')"
    );
  });

  it('rejects a non-string comment path', () => {
    expect(() =>
      validateResult({
        verdict: 'accept',
        comment: 42,
      })
    ).toThrowError("Invalid result.json:\n- 'comment' must be a string path");
  });

  it('rejects comment paths outside .shipper/output', () => {
    expect(() =>
      validateResult({
        verdict: 'accept',
        comment: '../comment-248.md',
      })
    ).toThrowError(
      "Invalid result.json:\n- 'comment' must be a relative path under .shipper/output"
    );
  });

  it('rejects optional fields with non-string values', () => {
    expect(() =>
      validateResult({
        verdict: 'accept',
        comment: '.shipper/output/comment-248.md',
        pr_spec: false,
        review_payload: 1,
        replies: [],
        groom: {},
      })
    ).toThrowError(
      "Invalid result.json:\n- 'pr_spec' must be a string path\n- 'review_payload' must be a string path\n- 'replies' must be a string path\n- 'groom' must be a string path"
    );
  });

  it('rejects optional payload paths outside .shipper/output', () => {
    expect(() =>
      validateResult({
        verdict: 'accept',
        comment: '.shipper/output/comment-248.md',
        pr_spec: '/tmp/pr-spec.json',
        review_payload: 'review.json',
        replies: '../replies',
        groom: '.shipper/input/groom.json',
      })
    ).toThrowError(
      "Invalid result.json:\n- 'pr_spec' must be a relative path under .shipper/output\n- 'review_payload' must be a relative path under .shipper/output\n- 'replies' must be a relative path under .shipper/output\n- 'groom' must be a relative path under .shipper/output"
    );
  });
});

describe('readResultFile', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads and validates a result file', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-result-schema-'));
    await writeFile(
      path.join(tempDir, 'result.json'),
      JSON.stringify({
        verdict: 'reject',
        comment: '.shipper/output/comment-248.md',
      }),
      'utf-8'
    );

    await expect(readResultFile(tempDir)).resolves.toEqual({
      verdict: 'reject',
      comment: '.shipper/output/comment-248.md',
    });
  });

  it('reports a missing result.json file', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-result-schema-'));

    await expect(readResultFile(tempDir)).rejects.toThrowError(
      `Missing result.json at ${path.join(tempDir, 'result.json')}`
    );
  });

  it('reports malformed JSON', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-result-schema-'));
    await writeFile(path.join(tempDir, 'result.json'), '{bad json', 'utf-8');

    await expect(readResultFile(tempDir)).rejects.toThrowError(
      new RegExp(`^Failed to parse ${escapeRegExp(path.join(tempDir, 'result.json'))}:`)
    );
  });

  it('preserves non-ENOENT read failures', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-result-schema-'));
    await mkdir(path.join(tempDir, 'result.json'));

    await expect(readResultFile(tempDir)).rejects.toThrowError(
      new RegExp(
        `^Failed to read result\\.json at ${escapeRegExp(path.join(tempDir, 'result.json'))}:`
      )
    );
  });

  it('reports schema validation failures from the file', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-result-schema-'));
    await writeFile(
      path.join(tempDir, 'result.json'),
      JSON.stringify({ verdict: 'accept' }),
      'utf-8'
    );

    await expect(readResultFile(tempDir)).rejects.toThrowError(
      `Invalid result.json at ${path.join(tempDir, 'result.json')}:\n- missing required field 'comment'`
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
