import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { toErrorMessage } from '../errors.js';
import { gh } from '../gh.js';
import { NEW_LABEL } from '../labels.js';
import {
  ResultValidationError,
  type CreatedIssueIdentity,
  type NewResultJson,
} from '../result-schema.js';
import { PROTOCOL_OUTPUT_DIR, resolveOutputPath } from './protocol-io.js';

export interface NewIssueDraftResultJson {
  issue_draft: string;
}

export interface NewIssueDraftJson {
  title: string;
  body_file: string;
}

export interface ValidatedNewIssueDraft {
  title: string;
  body_file: string;
  bodyPath: string;
  issue_draft: string;
  draftPath: string;
  resultPath: string;
}

const RESULT_ALLOWED_FIELDS = new Set(['issue_draft']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProtocolOutputPath(value: string): boolean {
  if (path.isAbsolute(value)) {
    return false;
  }

  const normalized = path.normalize(value);
  const relative = path.relative(PROTOCOL_OUTPUT_DIR, normalized);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function validateProtocolOutputPath(
  field: string,
  value: unknown,
  errors: string[]
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`'${field}' must be a string path`);
    return undefined;
  }

  if (!isProtocolOutputPath(value)) {
    errors.push(`'${field}' must be a relative path under .shipper/output`);
    return undefined;
  }

  return value;
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${filePath}: ${toErrorMessage(error)}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse ${label} at ${filePath}: ${toErrorMessage(error)}`);
  }
}

function validateNewIssueDraftResult(data: unknown): NewIssueDraftResultJson {
  const errors: string[] = [];

  if (!isRecord(data)) {
    throw new ResultValidationError(['result.json must be a JSON object']);
  }

  for (const field of Object.keys(data)) {
    if (!RESULT_ALLOWED_FIELDS.has(field)) {
      errors.push(`result.json must not contain '${field}' for the new draft protocol`);
    }
  }

  const issueDraft = validateProtocolOutputPath('issue_draft', data.issue_draft, errors);

  if (errors.length > 0 || issueDraft === undefined) {
    throw new ResultValidationError(errors);
  }

  return { issue_draft: issueDraft };
}

function validateNewIssueDraft(data: unknown, draftPath: string): NewIssueDraftJson {
  const errors: string[] = [];

  if (!isRecord(data)) {
    throw new ResultValidationError([`issue draft at ${draftPath} must be a JSON object`]);
  }

  const rawTitle = data.title;
  const title = typeof rawTitle === 'string' ? rawTitle : undefined;
  if (typeof rawTitle !== 'string') {
    errors.push("'title' must be a string");
  } else if (rawTitle.trim().length === 0) {
    errors.push("'title' must be a non-empty string");
  }

  const bodyFile = validateProtocolOutputPath('body_file', data.body_file, errors);

  if ('labels' in data) {
    errors.push("'labels' is not supported; Shipper applies labels during issue creation");
  }

  if (errors.length > 0 || title === undefined || bodyFile === undefined) {
    throw new ResultValidationError(errors, `Invalid issue draft at ${draftPath}`);
  }

  return { title, body_file: bodyFile };
}

function validateBodyTemplate(body: string, bodyPath: string): void {
  const firstNonEmptyLine = body
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();

  if (firstNonEmptyLine === '# Title') {
    throw new ResultValidationError(
      ["issue body must not start with a '# Title' heading"],
      `Invalid issue body at ${bodyPath}`
    );
  }
}

export async function readNewIssueDraft(cwd: string): Promise<ValidatedNewIssueDraft> {
  const resultPath = path.resolve(cwd, PROTOCOL_OUTPUT_DIR, 'result.json');
  const resultParsed = await readJsonFile(resultPath, 'result.json');
  const result = validateNewIssueDraftResult(resultParsed);
  const draftPath = resolveOutputPath(cwd, result.issue_draft, 'issue draft path');
  const draftParsed = await readJsonFile(draftPath, 'issue draft');
  const draft = validateNewIssueDraft(draftParsed, draftPath);
  const bodyPath = resolveOutputPath(cwd, draft.body_file, 'issue body path');

  let body: string;
  try {
    body = await readFile(bodyPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `issue body path does not exist or cannot be read: ${bodyPath}: ${toErrorMessage(error)}`
    );
  }
  validateBodyTemplate(body, bodyPath);

  return {
    title: draft.title,
    body_file: draft.body_file,
    bodyPath,
    issue_draft: result.issue_draft,
    draftPath,
    resultPath,
  };
}

function parseCreatedIssueNumber(url: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`Failed to parse created issue URL '${url}': ${toErrorMessage(error)}`);
  }

  const match = /\/issues\/(\d+)\/?$/.exec(parsed.pathname);
  if (!match) {
    throw new Error(`Failed to parse issue number from created issue URL '${url}'`);
  }

  return Number(match[1]);
}

export async function createIssueFromDraft(
  repo: string,
  draft: ValidatedNewIssueDraft
): Promise<CreatedIssueIdentity> {
  const { stdout } = await gh([
    'issue',
    'create',
    '-R',
    repo,
    '--title',
    draft.title,
    '--body-file',
    draft.bodyPath,
    '--label',
    NEW_LABEL,
  ]);
  const url = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .at(-1)
    ?.trim();
  if (!url) {
    throw new Error('gh issue create did not return an issue URL');
  }

  return {
    number: parseCreatedIssueNumber(url),
    title: draft.title,
    url,
  };
}

export async function writeCreatedIssueResult(
  cwd: string,
  createdIssue: CreatedIssueIdentity
): Promise<NewResultJson> {
  const result: NewResultJson = {
    created_issue: {
      number: createdIssue.number,
      title: createdIssue.title,
      url: createdIssue.url,
    },
  };
  const resultPath = path.resolve(cwd, PROTOCOL_OUTPUT_DIR, 'result.json');
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  return result;
}
