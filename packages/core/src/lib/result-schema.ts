import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type Verdict = 'accept' | 'reject' | 'fail';

export interface StageResult {
  verdict: Verdict;
  comment: string;
  pr_spec?: string;
  review_payload?: string;
  replies?: string;
}

export interface PRSpec {
  title: string;
  base: string;
  body: string;
  head?: string;
  draft?: boolean;
}

export interface ReviewPayloadComment {
  path: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments?: ReviewPayloadComment[];
}

export interface ParsedReviewPayload {
  payload: ReviewPayload;
  payloadPath: string;
}

export interface ReplyFile {
  commentId: string;
  path: string;
}

export class ResultValidationError extends Error {
  readonly retryable = true;

  constructor(
    message: string,
    readonly code: 'missing_result' | 'invalid_result' | 'missing_result_file'
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class MissingResultError extends ResultValidationError {
  constructor(message: string) {
    super(message, 'missing_result');
  }
}

export class InvalidResultError extends ResultValidationError {
  constructor(message: string) {
    super(message, 'invalid_result');
  }
}

export class MissingResultFileError extends ResultValidationError {
  constructor(message: string) {
    super(message, 'missing_result_file');
  }
}

const VERDICTS: Verdict[] = ['accept', 'reject', 'fail'];
const OPTIONAL_RESULT_FIELDS = ['pr_spec', 'review_payload', 'replies'] as const;
const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const;
const REVIEW_SIDES = ['LEFT', 'RIGHT'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  errorClass: typeof InvalidResultError = InvalidResultError
): string {
  if (typeof value !== 'string') {
    throw new errorClass(`result.${field} must be a string.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new errorClass(`result.${field} must not be empty.`);
  }

  return trimmed;
}

async function requireExistingPath(
  resolvedPath: string,
  description: string,
  errorClass: typeof MissingResultFileError = MissingResultFileError
): Promise<void> {
  try {
    await access(resolvedPath);
  } catch {
    throw new errorClass(`${description} does not exist: ${resolvedPath}`);
  }
}

async function readJsonFile(resolvedPath: string, description: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf-8');
  } catch {
    throw new MissingResultFileError(`${description} does not exist: ${resolvedPath}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidResultError(`${description} contains invalid JSON: ${message}`);
  }
}

export function isResultValidationError(error: unknown): error is ResultValidationError {
  return error instanceof ResultValidationError;
}

export function validateResult(raw: unknown): StageResult {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InvalidResultError(`result.json contains invalid JSON: ${message}`);
    }
  }

  if (!isPlainObject(parsed)) {
    throw new InvalidResultError('result.json must contain a JSON object.');
  }

  const verdict = requireNonEmptyString(parsed.verdict, 'verdict');
  if (!VERDICTS.includes(verdict as Verdict)) {
    throw new InvalidResultError(
      `result.verdict must be one of: ${VERDICTS.join(', ')}. Received: ${verdict}`
    );
  }

  const result: StageResult = {
    verdict: verdict as Verdict,
    comment: requireNonEmptyString(parsed.comment, 'comment'),
  };

  for (const field of OPTIONAL_RESULT_FIELDS) {
    const value = parsed[field];
    if (value === undefined) {
      continue;
    }
    result[field] = requireNonEmptyString(value, field);
  }

  return result;
}

export function resolveOutputPath(outputDir: string, relativePath: string): string {
  const candidate = requireNonEmptyString(relativePath, 'path');

  if (path.isAbsolute(candidate)) {
    throw new InvalidResultError(`Output paths must be relative to .shipper/output: ${candidate}`);
  }

  const normalized = path.normalize(candidate);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new InvalidResultError(`Output paths must stay within .shipper/output: ${candidate}`);
  }

  const resolvedOutputDir = path.resolve(outputDir);
  const resolved = path.resolve(resolvedOutputDir, normalized);
  const relativeToRoot = path.relative(resolvedOutputDir, resolved);

  if (
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new InvalidResultError(`Output paths must stay within .shipper/output: ${candidate}`);
  }

  return resolved;
}

export async function validateResultFiles(outputDir: string, result: StageResult): Promise<void> {
  await requireExistingPath(resolveOutputPath(outputDir, result.comment), 'Comment file');

  if (result.pr_spec) {
    await requireExistingPath(resolveOutputPath(outputDir, result.pr_spec), 'PR spec file');
  }

  if (result.review_payload) {
    await requireExistingPath(
      resolveOutputPath(outputDir, result.review_payload),
      'Review payload file'
    );
  }

  if (result.replies) {
    await requireExistingPath(resolveOutputPath(outputDir, result.replies), 'Replies directory');
  }
}

export async function parsePrSpec(outputDir: string, result: StageResult): Promise<PRSpec> {
  if (!result.pr_spec) {
    throw new InvalidResultError('result.pr_spec is required for PR creation.');
  }

  const specPath = resolveOutputPath(outputDir, result.pr_spec);
  const parsed = await readJsonFile(specPath, 'PR spec');
  if (!isPlainObject(parsed)) {
    throw new InvalidResultError('PR spec must contain a JSON object.');
  }

  const spec: PRSpec = {
    title: requireNonEmptyString(parsed.title, 'pr_spec.title'),
    base: requireNonEmptyString(parsed.base, 'pr_spec.base'),
    body: requireNonEmptyString(parsed.body, 'pr_spec.body'),
  };

  if (parsed.head !== undefined) {
    spec.head = requireNonEmptyString(parsed.head, 'pr_spec.head');
  }
  if (parsed.draft !== undefined) {
    if (typeof parsed.draft !== 'boolean') {
      throw new InvalidResultError('PR spec field "draft" must be a boolean.');
    }
    spec.draft = parsed.draft;
  }

  await requireExistingPath(resolveOutputPath(outputDir, spec.body), 'PR body file');

  return spec;
}

export async function parseReviewPayload(
  outputDir: string,
  result: StageResult
): Promise<ParsedReviewPayload> {
  if (!result.review_payload) {
    throw new InvalidResultError('result.review_payload is required for review submission.');
  }

  const payloadPath = resolveOutputPath(outputDir, result.review_payload);
  const parsed = await readJsonFile(payloadPath, 'Review payload');
  if (!isPlainObject(parsed)) {
    throw new InvalidResultError('Review payload must contain a JSON object.');
  }

  const event = requireNonEmptyString(parsed.event, 'review_payload.event');
  if (!REVIEW_EVENTS.includes(event as ReviewPayload['event'])) {
    throw new InvalidResultError(
      `Review payload event must be one of: ${REVIEW_EVENTS.join(', ')}. Received: ${event}`
    );
  }

  const payload: ReviewPayload = {
    commit_id: requireNonEmptyString(parsed.commit_id, 'review_payload.commit_id'),
    body: requireNonEmptyString(parsed.body, 'review_payload.body'),
    event: event as ReviewPayload['event'],
  };

  if (parsed.comments !== undefined) {
    if (!Array.isArray(parsed.comments)) {
      throw new InvalidResultError('Review payload comments must be an array when present.');
    }

    payload.comments = parsed.comments.map((comment, index) => {
      if (!isPlainObject(comment)) {
        throw new InvalidResultError(`Review payload comment ${index} must be an object.`);
      }

      const parsedComment: ReviewPayloadComment = {
        path: requireNonEmptyString(comment.path, `review_payload.comments[${index}].path`),
        body: requireNonEmptyString(comment.body, `review_payload.comments[${index}].body`),
      };

      if (comment.line !== undefined) {
        if (!Number.isInteger(comment.line) || Number(comment.line) < 1) {
          throw new InvalidResultError(
            `Review payload comment ${index} field "line" must be a positive integer.`
          );
        }
        parsedComment.line = Number(comment.line);
      }

      if (comment.start_line !== undefined) {
        if (!Number.isInteger(comment.start_line) || Number(comment.start_line) < 1) {
          throw new InvalidResultError(
            `Review payload comment ${index} field "start_line" must be a positive integer.`
          );
        }
        parsedComment.start_line = Number(comment.start_line);
      }

      if (comment.side !== undefined) {
        const side = requireNonEmptyString(comment.side, `review_payload.comments[${index}].side`);
        if (!REVIEW_SIDES.includes(side as 'LEFT' | 'RIGHT')) {
          throw new InvalidResultError(
            `Review payload comment ${index} field "side" must be LEFT or RIGHT.`
          );
        }
        parsedComment.side = side as ReviewPayloadComment['side'];
      }

      if (comment.start_side !== undefined) {
        const startSide = requireNonEmptyString(
          comment.start_side,
          `review_payload.comments[${index}].start_side`
        );
        if (!REVIEW_SIDES.includes(startSide as 'LEFT' | 'RIGHT')) {
          throw new InvalidResultError(
            `Review payload comment ${index} field "start_side" must be LEFT or RIGHT.`
          );
        }
        parsedComment.start_side = startSide as ReviewPayloadComment['start_side'];
      }

      return parsedComment;
    });
  }

  return { payload, payloadPath };
}

export async function parseReplies(outputDir: string, result: StageResult): Promise<ReplyFile[]> {
  if (!result.replies) {
    return [];
  }

  const repliesPath = resolveOutputPath(outputDir, result.replies);
  let entries;
  try {
    entries = await readdir(repliesPath, { withFileTypes: true });
  } catch {
    throw new MissingResultFileError(`Replies directory does not exist: ${repliesPath}`);
  }

  const replies: ReplyFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!/^\d+$/.test(entry.name)) {
      throw new InvalidResultError(
        `Reply filenames must be numeric review comment IDs. Received: ${entry.name}`
      );
    }

    const replyPath = path.join(repliesPath, entry.name);
    await requireExistingPath(replyPath, `Reply file for comment ${entry.name}`);
    replies.push({ commentId: entry.name, path: replyPath });
  }

  replies.sort((a, b) => Number(a.commentId) - Number(b.commentId));
  return replies;
}
