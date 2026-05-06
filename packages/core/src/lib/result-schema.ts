import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { toErrorMessage } from './errors.js';
import type { Verdict } from './stage-transitions.js';

export interface ResultJson {
  verdict: Verdict;
  comment: string;
  pr_spec?: string;
  review_payload?: string;
  replies?: string;
  groom?: string;
}

export interface CreatedIssueIdentity {
  number: number;
  title: string;
  url: string;
}

export interface NewResultJson {
  created_issue: CreatedIssueIdentity;
}

export const VALID_VERDICTS = ['accept', 'reject', 'fail'] as const;
const PROTOCOL_OUTPUT_DIR = path.join('.shipper', 'output');

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

function isProtocolOutputPath(value: string): boolean {
  if (path.isAbsolute(value)) {
    return false;
  }

  const normalized = path.normalize(value);
  const relative = path.relative(PROTOCOL_OUTPUT_DIR, normalized);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function validateProtocolPath(field: string, value: unknown, errors: string[]): void {
  if (typeof value !== 'string') {
    errors.push(`'${field}' must be a string path`);
    return;
  }

  if (!isProtocolOutputPath(value)) {
    errors.push(`'${field}' must be a relative path under .shipper/output`);
  }
}

function validateOptionalPath(
  data: Record<string, unknown>,
  field: 'pr_spec' | 'review_payload' | 'replies' | 'groom',
  errors: string[]
): void {
  const value = data[field];
  if (value !== undefined) {
    validateProtocolPath(field, value, errors);
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
  } else {
    validateProtocolPath('comment', data.comment, errors);
  }

  validateOptionalPath(data, 'pr_spec', errors);
  validateOptionalPath(data, 'review_payload', errors);
  validateOptionalPath(data, 'replies', errors);
  validateOptionalPath(data, 'groom', errors);

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

  if (typeof data.groom === 'string') {
    result.groom = data.groom;
  }

  return result;
}

export function validateNewResult(data: unknown): NewResultJson {
  const errors: string[] = [];

  if (!isRecord(data)) {
    throw new ResultValidationError(['result.json must be a JSON object']);
  }

  if (!('created_issue' in data)) {
    errors.push("missing required field 'created_issue'");
  } else if (!isRecord(data.created_issue)) {
    errors.push("'created_issue' must be a JSON object");
  } else {
    const createdIssue = data.created_issue;
    if (
      typeof createdIssue.number !== 'number' ||
      !Number.isInteger(createdIssue.number) ||
      createdIssue.number <= 0
    ) {
      errors.push("'created_issue.number' must be a positive integer");
    }

    if (typeof createdIssue.title !== 'string' || createdIssue.title.trim().length === 0) {
      errors.push("'created_issue.title' must be a non-empty string");
    }

    if (typeof createdIssue.url !== 'string' || createdIssue.url.trim().length === 0) {
      errors.push("'created_issue.url' must be a non-empty string");
    }
  }

  if (errors.length > 0) {
    throw new ResultValidationError(errors);
  }

  const createdIssue = (data as { created_issue: CreatedIssueIdentity }).created_issue;
  return {
    created_issue: {
      number: createdIssue.number,
      title: createdIssue.title.trim(),
      url: createdIssue.url.trim(),
    },
  };
}

async function readJsonResultFile<T>(
  resultPath: string,
  validator: (data: unknown) => T
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf-8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Missing result.json at ${resultPath}`);
    }

    throw new Error(`Failed to read result.json at ${resultPath}: ${toErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse ${resultPath}: ${toErrorMessage(error)}`);
  }

  try {
    return validator(parsed);
  } catch (error) {
    if (error instanceof ResultValidationError) {
      throw new ResultValidationError(error.errors, `Invalid result.json at ${resultPath}`);
    }

    throw error;
  }
}

export async function readResultFile(outputDir: string): Promise<ResultJson> {
  return await readJsonResultFile(path.join(outputDir, 'result.json'), validateResult);
}

export async function readNewResultFile(resultPath: string): Promise<NewResultJson> {
  return await readJsonResultFile(resultPath, validateNewResult);
}
