import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readNewResultFile,
  readResultFile,
  ResultValidationError,
  validateNewResult,
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
    expect(() => validateResult('bad')).toThrow(
      new ResultValidationError(['result.json must be a JSON object'])
    );
  });

  it('rejects null input', () => {
    expect(() => validateResult(null)).toThrow(
      new ResultValidationError(['result.json must be a JSON object'])
    );
  });

  it('reports every missing required field', () => {
    expect(() => validateResult({})).toThrow(
      "Invalid result.json:\n- missing required field 'verdict'\n- missing required field 'comment'"
    );
  });

  it('rejects an invalid verdict value', () => {
    expect(() =>
      validateResult({
        verdict: 'approved',
        comment: '.shipper/output/comment-248.md',
      })
    ).toThrow(
      "Invalid result.json:\n- 'verdict' must be one of: accept, reject, fail (got 'approved')"
    );
  });

  it('rejects a non-string comment path', () => {
    expect(() =>
      validateResult({
        verdict: 'accept',
        comment: 42,
      })
    ).toThrow("Invalid result.json:\n- 'comment' must be a string path");
  });

  it('rejects comment paths outside .shipper/output', () => {
    expect(() =>
      validateResult({
        verdict: 'accept',
        comment: '../comment-248.md',
      })
    ).toThrow("Invalid result.json:\n- 'comment' must be a relative path under .shipper/output");
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
    ).toThrow(
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
    ).toThrow(
      "Invalid result.json:\n- 'pr_spec' must be a relative path under .shipper/output\n- 'review_payload' must be a relative path under .shipper/output\n- 'replies' must be a relative path under .shipper/output\n- 'groom' must be a relative path under .shipper/output"
    );
  });
});

describe('validateNewResult', () => {
  it('accepts a valid created issue result', () => {
    expect(
      validateNewResult({
        created_issue: {
          number: 42,
          title: 'Add generated MCP reference pages',
          url: 'https://github.com/owner/repo/issues/42',
        },
      })
    ).toEqual({
      created_issue: {
        number: 42,
        title: 'Add generated MCP reference pages',
        url: 'https://github.com/owner/repo/issues/42',
      },
    });
  });

  it('preserves created_issue title and url bytes while validating trimmed non-blank values', () => {
    expect(
      validateNewResult({
        created_issue: {
          number: 42,
          title: '  Keep exact title  ',
          url: ' https://github.com/owner/repo/issues/42 ',
        },
      })
    ).toEqual({
      created_issue: {
        number: 42,
        title: '  Keep exact title  ',
        url: ' https://github.com/owner/repo/issues/42 ',
      },
    });
  });

  it('rejects non-object input', () => {
    expect(() => validateNewResult('bad')).toThrow(
      new ResultValidationError(['result.json must be a JSON object'])
    );
  });

  it('reports a missing created_issue field', () => {
    expect(() => validateNewResult({})).toThrow(
      "Invalid result.json:\n- missing required field 'created_issue'"
    );
  });

  it('rejects a non-object created_issue field', () => {
    expect(() => validateNewResult({ created_issue: 'bad' })).toThrow(
      "Invalid result.json:\n- 'created_issue' must be a JSON object"
    );
  });

  it.each([0, -1, 1.5, '42'])('rejects invalid issue number %s', (number) => {
    expect(() =>
      validateNewResult({
        created_issue: {
          number,
          title: 'Valid title',
          url: 'https://github.com/owner/repo/issues/42',
        },
      })
    ).toThrow("Invalid result.json:\n- 'created_issue.number' must be a positive integer");
  });

  it.each(['title', 'url'] as const)('rejects a blank %s', (field) => {
    expect(() =>
      validateNewResult({
        created_issue: {
          number: 42,
          title: field === 'title' ? '   ' : 'Valid title',
          url: field === 'url' ? '' : 'https://github.com/owner/repo/issues/42',
        },
      })
    ).toThrow(`Invalid result.json:\n- 'created_issue.${field}' must be a non-empty string`);
  });

  it.each(['title', 'url'] as const)('rejects a non-string %s', (field) => {
    expect(() =>
      validateNewResult({
        created_issue: {
          number: 42,
          title: field === 'title' ? 7 : 'Valid title',
          url: field === 'url' ? 7 : 'https://github.com/owner/repo/issues/42',
        },
      })
    ).toThrow(`Invalid result.json:\n- 'created_issue.${field}' must be a non-empty string`);
  });

  it('ignores unrelated extra fields', () => {
    expect(
      validateNewResult({
        created_issue: {
          number: 42,
          title: 'Valid title',
          url: 'https://github.com/owner/repo/issues/42',
          ignored: true,
        },
        ignored: true,
      })
    ).toEqual({
      created_issue: {
        number: 42,
        title: 'Valid title',
        url: 'https://github.com/owner/repo/issues/42',
      },
    });
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

    await expect(readResultFile(tempDir)).rejects.toThrow(
      `Missing result.json at ${path.join(tempDir, 'result.json')}`
    );
  });

  it('reports malformed JSON', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-result-schema-'));
    await writeFile(path.join(tempDir, 'result.json'), '{bad json', 'utf-8');

    await expect(readResultFile(tempDir)).rejects.toThrow(
      new RegExp(`^Failed to parse ${escapeRegExp(path.join(tempDir, 'result.json'))}:`)
    );
  });

  it('preserves non-ENOENT read failures', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-result-schema-'));
    await mkdir(path.join(tempDir, 'result.json'));

    await expect(readResultFile(tempDir)).rejects.toThrow(
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

    await expect(readResultFile(tempDir)).rejects.toThrow(
      `Invalid result.json at ${path.join(tempDir, 'result.json')}:\n- missing required field 'comment'`
    );
  });
});

describe('readNewResultFile', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads and validates a result file from a full path', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-new-result-schema-'));
    const resultPath = path.join(tempDir, 'new.result.json');
    await writeFile(
      resultPath,
      JSON.stringify({
        created_issue: {
          number: 42,
          title: 'Add generated MCP reference pages',
          url: 'https://github.com/owner/repo/issues/42',
        },
      }),
      'utf-8'
    );

    await expect(readNewResultFile(resultPath)).resolves.toEqual({
      created_issue: {
        number: 42,
        title: 'Add generated MCP reference pages',
        url: 'https://github.com/owner/repo/issues/42',
      },
    });
  });

  it('reports a missing result.json file', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-new-result-schema-'));
    const resultPath = path.join(tempDir, 'new.result.json');

    await expect(readNewResultFile(resultPath)).rejects.toThrow(
      `Missing result.json at ${resultPath}`
    );
  });

  it('reports malformed JSON', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-new-result-schema-'));
    const resultPath = path.join(tempDir, 'new.result.json');
    await writeFile(resultPath, '{bad json', 'utf-8');

    await expect(readNewResultFile(resultPath)).rejects.toThrow(
      new RegExp(`^Failed to parse ${escapeRegExp(resultPath)}:`)
    );
  });

  it('preserves non-ENOENT read failures', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-new-result-schema-'));
    const resultPath = path.join(tempDir, 'new.result.json');
    await mkdir(resultPath);

    await expect(readNewResultFile(resultPath)).rejects.toThrow(
      new RegExp(`^Failed to read result\\.json at ${escapeRegExp(resultPath)}:`)
    );
  });

  it('reports schema validation failures from the file', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'shipper-new-result-schema-'));
    const resultPath = path.join(tempDir, 'new.result.json');
    await writeFile(resultPath, JSON.stringify({ created_issue: { number: 0 } }), 'utf-8');

    await expect(readNewResultFile(resultPath)).rejects.toThrow(
      `Invalid result.json at ${resultPath}:\n- 'created_issue.number' must be a positive integer\n- 'created_issue.title' must be a non-empty string\n- 'created_issue.url' must be a non-empty string`
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
