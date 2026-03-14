import path from 'node:path';
import { readFile } from 'node:fs/promises';

import type { Verdict } from './stage-transitions.js';

export interface ResultJson {
  verdict: Verdict;
  comment: string;
  pr_spec?: string;
  review_payload?: string;
  replies?: string;
}

export const VALID_VERDICTS = ['accept', 'reject', 'fail'] as const;

export class ResultValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[], prefix = 'Invalid result.json') {
    super(`${prefix}:\n- ${errors.join('\n- ')}`);
    this.name = 'ResultValidationError';
    this.errors = errors;
  }
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

function validateOptionalPath(
  data: Record<string, unknown>,
  field: 'pr_spec' | 'review_payload' | 'replies',
  errors: string[]
): void {
  const value = data[field];
  if (value !== undefined && typeof value !== 'string') {
    errors.push(`'${field}' must be a string path`);
  }
}

export function validateResult(data: unknown): ResultJson {
  const errors: string[] = [];

  if (!isRecord(data)) {
    throw new ResultValidationError(['result.json must be a JSON object']);
  }

  if (!('verdict' in data)) {
    errors.push("missing required field 'verdict'");
  } else if (
    typeof data.verdict !== 'string' ||
    !VALID_VERDICTS.includes(data.verdict as Verdict)
  ) {
    errors.push(`'verdict' must be one of: accept, reject, fail (got '${String(data.verdict)}')`);
  }

  if (!('comment' in data)) {
    errors.push("missing required field 'comment'");
  } else if (typeof data.comment !== 'string') {
    errors.push("'comment' must be a string path");
  }

  validateOptionalPath(data, 'pr_spec', errors);
  validateOptionalPath(data, 'review_payload', errors);
  validateOptionalPath(data, 'replies', errors);

  if (errors.length > 0) {
    throw new ResultValidationError(errors);
  }

  const result: ResultJson = {
    verdict: data.verdict as Verdict,
    comment: data.comment as string,
  };

  if (typeof data.pr_spec === 'string') {
    result.pr_spec = data.pr_spec;
  }

  if (typeof data.review_payload === 'string') {
    result.review_payload = data.review_payload;
  }

  if (typeof data.replies === 'string') {
    result.replies = data.replies;
  }

  return result;
}

export async function readResultFile(outputDir: string): Promise<ResultJson> {
  const resultPath = path.join(outputDir, 'result.json');

  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf-8');
  } catch {
    throw new Error(`Missing result.json at ${resultPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${resultPath}: ${message}`);
  }

  try {
    return validateResult(parsed);
  } catch (error) {
    if (error instanceof ResultValidationError) {
      throw new ResultValidationError(error.errors, `Invalid result.json at ${resultPath}`);
    }

    throw error;
  }
}
