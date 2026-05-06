import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { formatValidRanges, includesLine, type DiffFileHunks } from './diff-parse.js';
import { PROTOCOL_OUTPUT_DIR, resolveOutputPath, truncateLargeInput } from './protocol-io.js';
import { toErrorMessage } from '../errors.js';
import { getGhErrorDetail, isRecoverableReviewSubmissionGhError } from '../gh.js';
import { readResultFile, ResultValidationError, type ResultJson } from '../result-schema.js';
import type { StageName } from '../stage-transitions.js';
import { readGroomManifest } from './groom.js';

const REVIEW_VALID_FILES_DISPLAY_LIMIT = 50;

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type ReviewCommentSide = 'LEFT' | 'RIGHT';

export interface PrSpecJson {
  title: string;
  body_file: string;
  base: string;
  head_branch: string;
  draft: boolean;
}

export interface ReviewPayloadComment {
  path: string;
  line: number;
  side: ReviewCommentSide;
  body: string;
  start_line?: number;
  start_side?: ReviewCommentSide;
}

export interface ReviewPayloadJson {
  commit_id: string;
  body: string;
  event: ReviewEvent;
  comments: ReviewPayloadComment[];
}

const VALID_REVIEW_EVENTS = new Set<ReviewEvent>(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const VALID_REVIEW_COMMENT_SIDES = new Set<ReviewCommentSide>(['LEFT', 'RIGHT']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringField(
  data: Record<string, unknown>,
  field: string,
  errors: string[]
): string | undefined {
  const value = data[field];
  if (typeof value !== 'string') {
    errors.push(`'${field}' must be a string`);
    return undefined;
  }

  return value;
}

function validateBooleanField(
  data: Record<string, unknown>,
  field: string,
  errors: string[]
): boolean | undefined {
  const value = data[field];
  if (typeof value !== 'boolean') {
    errors.push(`'${field}' must be a boolean`);
    return undefined;
  }

  return value;
}

function validateNumberField(
  data: Record<string, unknown>,
  field: string,
  errors: string[]
): number | undefined {
  const value = data[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    errors.push(`'${field}' must be a positive integer`);
    return undefined;
  }

  return value;
}

function validateReviewComment(
  comment: unknown,
  index: number,
  errors: string[]
): ReviewPayloadComment | undefined {
  if (!isRecord(comment)) {
    errors.push(`'comments[${index}]' must be an object`);
    return undefined;
  }

  const pathValue = validateStringField(comment, 'path', errors);
  const lineValue = validateNumberField(comment, 'line', errors);
  const bodyValue = validateStringField(comment, 'body', errors);
  const sideValue = validateStringField(comment, 'side', errors);
  const startLineValue =
    comment.start_line === undefined
      ? undefined
      : validateNumberField(comment, 'start_line', errors);
  const startSideValue =
    comment.start_side === undefined
      ? undefined
      : validateStringField(comment, 'start_side', errors);

  if (sideValue !== undefined && !VALID_REVIEW_COMMENT_SIDES.has(sideValue as ReviewCommentSide)) {
    errors.push(`'comments[${index}].side' must be LEFT or RIGHT`);
  }

  if (
    startSideValue !== undefined &&
    !VALID_REVIEW_COMMENT_SIDES.has(startSideValue as ReviewCommentSide)
  ) {
    errors.push(`'comments[${index}].start_side' must be LEFT or RIGHT`);
  }

  const hasStartLine = comment.start_line !== undefined;
  const hasStartSide = comment.start_side !== undefined;
  if (hasStartLine !== hasStartSide) {
    errors.push(
      `'comments[${index}].start_line' and 'comments[${index}].start_side' must be provided together`
    );
  }

  if (
    pathValue === undefined ||
    lineValue === undefined ||
    bodyValue === undefined ||
    sideValue === undefined ||
    (comment.start_line !== undefined && startLineValue === undefined) ||
    (comment.start_side !== undefined && startSideValue === undefined)
  ) {
    return undefined;
  }

  return {
    path: pathValue,
    line: lineValue,
    side: sideValue as ReviewCommentSide,
    body: bodyValue,
    ...(startLineValue === undefined ? {} : { start_line: startLineValue }),
    ...(startSideValue === undefined ? {} : { start_side: startSideValue as ReviewCommentSide }),
  };
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`Failed to parse ${label} at ${filePath}: ${message}`);
  }
}

async function assertReadableOutputFile(
  cwd: string,
  relativePath: string,
  label: string
): Promise<void> {
  let abs: string;
  try {
    abs = resolveOutputPath(cwd, relativePath, label);
  } catch (error) {
    throw new Error(toErrorMessage(error));
  }

  try {
    await readFile(abs, 'utf-8');
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be read: ${abs}: ${toErrorMessage(error)}`);
  }
}

export async function readPrSpec(
  cwd: string,
  specPath: string
): Promise<{ abs: string; spec: PrSpecJson }> {
  const abs = resolveOutputPath(cwd, specPath, 'PR spec path');
  const parsed = await readJsonFile(abs, 'PR spec');
  const errors: string[] = [];

  if (!isRecord(parsed)) {
    throw new Error(`Invalid PR spec at ${abs}:\n- PR spec must be a JSON object`);
  }

  const title = validateStringField(parsed, 'title', errors);
  const bodyFile = validateStringField(parsed, 'body_file', errors);
  const base = validateStringField(parsed, 'base', errors);
  const headBranch = validateStringField(parsed, 'head_branch', errors);
  const draft = validateBooleanField(parsed, 'draft', errors);

  if (bodyFile !== undefined) {
    let bodyPath: string | undefined;
    try {
      bodyPath = resolveOutputPath(cwd, bodyFile, 'PR body path');
      await readFile(bodyPath, 'utf-8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        errors.push(`PR body path does not exist: ${bodyPath ?? bodyFile}`);
      } else {
        errors.push(toErrorMessage(error));
      }
    }
  }

  if (
    errors.length > 0 ||
    title === undefined ||
    bodyFile === undefined ||
    base === undefined ||
    headBranch === undefined ||
    draft === undefined
  ) {
    throw new Error(`Invalid PR spec at ${abs}:\n- ${errors.join('\n- ')}`);
  }

  return {
    abs,
    spec: {
      title,
      body_file: bodyFile,
      base,
      head_branch: headBranch,
      draft,
    },
  };
}

export async function readReviewPayload(
  cwd: string,
  payloadPath: string,
  prFiles?: Set<string>,
  diffHunks?: Map<string, DiffFileHunks>
): Promise<{ abs: string; payload: ReviewPayloadJson }> {
  const abs = resolveOutputPath(cwd, payloadPath, 'review payload path');
  const parsed = await readJsonFile(abs, 'review payload');
  const errors: string[] = [];

  if (!isRecord(parsed)) {
    throw new Error(`Invalid review payload at ${abs}:\n- review payload must be a JSON object`);
  }

  const commitId = validateStringField(parsed, 'commit_id', errors);
  const body = validateStringField(parsed, 'body', errors);
  const event = validateStringField(parsed, 'event', errors);
  if (event !== undefined && !VALID_REVIEW_EVENTS.has(event as ReviewEvent)) {
    errors.push(`'event' must be one of: APPROVE, REQUEST_CHANGES, COMMENT`);
  }

  if (!Array.isArray(parsed.comments)) {
    errors.push(`'comments' must be an array`);
  }

  const comments = Array.isArray(parsed.comments)
    ? parsed.comments
        .map((comment, index) => ({
          index,
          comment: validateReviewComment(comment, index, errors),
        }))
        .filter(
          (
            entry
          ): entry is {
            index: number;
            comment: ReviewPayloadComment;
          } => entry.comment !== undefined
        )
    : [];

  const invalidPaths = new Set<string>();
  if (prFiles) {
    for (const { comment } of comments) {
      if (!prFiles.has(comment.path)) {
        invalidPaths.add(comment.path);
      }
    }

    if (invalidPaths.size > 0) {
      const validFiles = [...prFiles];
      const displayedValidFiles = validFiles.slice(0, REVIEW_VALID_FILES_DISPLAY_LIMIT);
      const remainingValidFileCount = validFiles.length - displayedValidFiles.length;
      const validFilesDisplay =
        validFiles.length === 0
          ? '(none)'
          : remainingValidFileCount > 0
            ? `${displayedValidFiles.join(', ')} (and ${remainingValidFileCount} more)`
            : displayedValidFiles.join(', ');
      errors.push(
        `comment path(s) not in PR diff: ${[...invalidPaths].join(', ')}. Valid files: ${validFilesDisplay}`
      );
    }
  }

  if (diffHunks) {
    for (const { index, comment } of comments) {
      if (invalidPaths.has(comment.path)) {
        continue;
      }

      const fileHunks = diffHunks.get(comment.path);
      const sideRanges =
        comment.side === 'LEFT' ? (fileHunks?.left ?? []) : (fileHunks?.right ?? []);
      if (!includesLine(sideRanges, comment.line)) {
        errors.push(
          `comments[${index}].line ${comment.line} (side ${comment.side}) is not within any diff hunk for '${comment.path}'. ${formatValidRanges(fileHunks)}`
        );
      }

      if (comment.start_line === undefined || comment.start_side === undefined) {
        continue;
      }

      const startSideRanges =
        comment.start_side === 'LEFT' ? (fileHunks?.left ?? []) : (fileHunks?.right ?? []);
      if (!includesLine(startSideRanges, comment.start_line)) {
        errors.push(
          `comments[${index}].start_line ${comment.start_line} (side ${comment.start_side}) is not within any diff hunk for '${comment.path}'. ${formatValidRanges(fileHunks)}`
        );
      }
    }
  }

  if (errors.length > 0 || commitId === undefined || body === undefined || event === undefined) {
    throw new Error(`Invalid review payload at ${abs}:\n- ${errors.join('\n- ')}`);
  }

  return {
    abs,
    payload: {
      commit_id: commitId,
      body,
      event: event as ReviewEvent,
      comments: comments.map(({ comment }) => comment),
    },
  };
}

export async function validateStageOutput(
  cwd: string,
  stage: StageName,
  prFiles?: Set<string>,
  diffHunks?: Map<string, DiffFileHunks>
): Promise<ResultJson> {
  const result = await readResultFile(path.resolve(cwd, PROTOCOL_OUTPUT_DIR));

  // pr_remediate has a custom artifact flow and only depends on result.json schema here.
  if (stage === 'pr_remediate') {
    return result;
  }

  if (result.pr_spec && stage !== 'pr_open') {
    throw new Error(`result.pr_spec is only supported for the pr_open stage (got ${stage})`);
  }

  if (result.review_payload && stage !== 'pr_review') {
    throw new Error(
      `result.review_payload is only supported for the pr_review stage (got ${stage})`
    );
  }

  if (result.groom && stage !== 'groom') {
    throw new Error(`result.groom is only supported for the groom stage (got ${stage})`);
  }

  if (stage === 'groom') {
    if (result.pr_spec) {
      throw new Error('result.pr_spec is not supported for the groom stage');
    }
    if (result.review_payload) {
      throw new Error('result.review_payload is not supported for the groom stage');
    }
    if (result.replies) {
      throw new Error('result.replies is not supported for the groom stage');
    }
    if (result.verdict !== 'accept') {
      throw new Error('groom output must use verdict accept');
    }
    if (!result.groom) {
      throw new Error('groom accept requires a groom manifest in result.json');
    }
    await assertReadableOutputFile(cwd, result.comment, 'groom comment file');
    await readGroomManifest(cwd, result.groom);
    return result;
  }

  if (result.verdict === 'accept' && stage === 'pr_open' && !result.pr_spec) {
    throw new Error('pr_open accept requires a pr_spec in result.json');
  }

  if (result.verdict === 'accept' && stage === 'pr_review' && !result.review_payload) {
    throw new Error('pr_review accept requires a review_payload in result.json');
  }

  if (result.pr_spec) {
    await readPrSpec(cwd, result.pr_spec);
  }

  if (result.review_payload) {
    await readReviewPayload(
      cwd,
      result.review_payload,
      stage === 'pr_review' ? prFiles : undefined,
      stage === 'pr_review' ? diffHunks : undefined
    );
  }

  return result;
}

const MAX_VALIDATION_ATTEMPTS = 3;

export async function retryOnInvalidOutput(opts: {
  cwd: string;
  stage: StageName;
  prFiles?: Set<string>;
  diffHunks?: Map<string, DiffFileHunks>;
  retry: (correctionMessage: string) => Promise<number>;
}): Promise<ResultJson> {
  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
    try {
      return await validateStageOutput(opts.cwd, opts.stage, opts.prFiles, opts.diffHunks);
    } catch (error) {
      if (attempt === MAX_VALIDATION_ATTEMPTS) {
        throw error;
      }

      const errors =
        error instanceof ResultValidationError ? error.errors : [toErrorMessage(error)];
      await opts.retry(formatCorrectionMessage(errors));
    }
  }

  throw new Error('Unreachable: retryOnInvalidOutput exhausted attempts without returning.');
}

export interface PrReviewRetryContext {
  prFiles?: Set<string>;
  diffHunks?: Map<string, DiffFileHunks>;
}

export interface RetryPrReviewOutputAndSubmissionResult {
  result: ResultJson;
  reviewSubmitted: boolean;
}

function formatGitHubReviewRejectionCorrectionMessage(detail: string): string {
  return [
    'GitHub rejected the review payload after it passed Shipper validation. Fix the review payload and produce a valid .shipper/output/result.json.',
    '',
    detail,
  ].join('\n');
}

export async function retryPrReviewOutputAndSubmission(opts: {
  cwd: string;
  prFiles?: Set<string>;
  diffHunks?: Map<string, DiffFileHunks>;
  retry: (correctionMessage: string) => Promise<number>;
  submitReviewPayload: (payloadPath: string) => Promise<void>;
  refreshContext?: () => Promise<PrReviewRetryContext | undefined>;
}): Promise<RetryPrReviewOutputAndSubmissionResult> {
  let currentPrFiles = opts.prFiles;
  let currentDiffHunks = opts.diffHunks;

  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
    let result: ResultJson;
    try {
      result = await validateStageOutput(opts.cwd, 'pr_review', currentPrFiles, currentDiffHunks);
    } catch (error) {
      if (attempt === MAX_VALIDATION_ATTEMPTS) {
        throw error;
      }

      const errors =
        error instanceof ResultValidationError ? error.errors : [toErrorMessage(error)];
      await opts.retry(formatCorrectionMessage(errors));
      continue;
    }

    if (result.verdict !== 'accept') {
      return { result, reviewSubmitted: false };
    }
    if (!result.review_payload) {
      throw new Error('pr_review accept requires a review_payload in result.json');
    }

    try {
      await opts.submitReviewPayload(result.review_payload);
      return { result, reviewSubmitted: true };
    } catch (error) {
      if (!isRecoverableReviewSubmissionGhError(error) || attempt === MAX_VALIDATION_ATTEMPTS) {
        throw error;
      }

      const refreshedContext = await opts.refreshContext?.();
      if (refreshedContext) {
        currentPrFiles = refreshedContext.prFiles;
        currentDiffHunks = refreshedContext.diffHunks;
      }

      const detail = await truncateLargeInput(
        opts.cwd,
        getGhErrorDetail(error),
        'github-review-rejection.txt'
      );
      await opts.retry(formatGitHubReviewRejectionCorrectionMessage(detail));
    }
  }

  throw new Error(
    'Unreachable: retryPrReviewOutputAndSubmission exhausted attempts without returning.'
  );
}

export function formatCorrectionMessage(errors: string[]): string {
  return [
    'Your previous output was invalid. Fix the following and produce a valid .shipper/output/result.json:',
    ...errors.map((error) => `- ${error}`),
  ].join('\n');
}
