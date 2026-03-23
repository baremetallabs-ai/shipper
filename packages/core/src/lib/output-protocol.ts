import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gh } from './gh.js';
import { readResultFile, ResultValidationError, type ResultJson } from './result-schema.js';
import { resolveTransition, type LabelTransition, type StageName } from './stage-transitions.js';

export const PROTOCOL_INPUT_DIR = path.join('.shipper', 'input');
export const PROTOCOL_OUTPUT_DIR = path.join('.shipper', 'output');
const TRUNCATION_THRESHOLD_BYTES = 50_000;
const TRUNCATION_HEAD_LINES = 50;
const TRUNCATION_TAIL_LINES = 50;
const TRUNCATION_HEAD_BYTES = 10_000;
const TRUNCATION_TAIL_BYTES = 10_000;

type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
type ReviewCommentSide = 'LEFT' | 'RIGHT';

interface PrSpecJson {
  title: string;
  body_file: string;
  base: string;
  head_branch: string;
  draft: boolean;
}

interface ReviewPayloadComment {
  path: string;
  line: number;
  side: ReviewCommentSide;
  body: string;
  start_line?: number;
  start_side?: ReviewCommentSide;
}

interface ReviewPayloadJson {
  commit_id: string;
  body: string;
  event: ReviewEvent;
  comments: ReviewPayloadComment[];
}

const VALID_REVIEW_EVENTS = new Set<ReviewEvent>(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const VALID_REVIEW_COMMENT_SIDES = new Set<ReviewCommentSide>(['LEFT', 'RIGHT']);

function resolveContainedPath(rootDir: string, relativePath: string, label: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path`);
  }

  const resolvedPath = path.resolve(rootDir, relativePath);
  const relativeToRoot = path.relative(rootDir, resolvedPath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`${label} must stay within ${rootDir}`);
  }

  return resolvedPath;
}

function resolveOutputPath(cwd: string, outputPath: string, label = 'output path'): string {
  const outputDir = path.resolve(cwd, PROTOCOL_OUTPUT_DIR);
  const resolvedPath = path.resolve(cwd, outputPath);
  const relativeToOutputDir = path.relative(outputDir, resolvedPath);
  if (relativeToOutputDir.startsWith('..') || path.isAbsolute(relativeToOutputDir)) {
    throw new Error(`${label} must stay within ${outputDir}`);
  }

  return resolvedPath;
}

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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} at ${filePath}: ${message}`);
  }
}

async function readPrSpec(
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
        errors.push(error instanceof Error ? error.message : String(error));
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

async function readReviewPayload(
  cwd: string,
  payloadPath: string
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
        .map((comment, index) => validateReviewComment(comment, index, errors))
        .filter((comment): comment is ReviewPayloadComment => comment !== undefined)
    : [];

  if (errors.length > 0 || commitId === undefined || body === undefined || event === undefined) {
    throw new Error(`Invalid review payload at ${abs}:\n- ${errors.join('\n- ')}`);
  }

  return {
    abs,
    payload: {
      commit_id: commitId,
      body,
      event: event as ReviewEvent,
      comments,
    },
  };
}

export async function setupProtocolDirs(cwd: string): Promise<void> {
  await mkdir(path.resolve(cwd, PROTOCOL_INPUT_DIR), { recursive: true });
  await mkdir(path.resolve(cwd, PROTOCOL_OUTPUT_DIR), { recursive: true });
}

export async function scrubOutputDir(cwd: string): Promise<void> {
  const outputDir = path.resolve(cwd, PROTOCOL_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });

  const entries = await readdir(outputDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== '.gitkeep')
      .map(async (entry) => {
        const entryPath = path.join(outputDir, entry.name);
        if (entry.isDirectory()) {
          await rm(entryPath, { recursive: true, force: true });
          return;
        }

        await unlink(entryPath);
      })
  );
}

export async function writeContextFile(
  cwd: string,
  filename: string,
  content: string
): Promise<void> {
  const inputDir = path.resolve(cwd, PROTOCOL_INPUT_DIR);
  const filePath = resolveContainedPath(inputDir, filename, 'context filename');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

function truncateByBytes(text: string, maxBytes: number, fromEnd = false): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return text;
  }

  let result = fromEnd ? text.slice(-maxBytes) : text.slice(0, maxBytes);
  while (Buffer.byteLength(result, 'utf-8') > maxBytes) {
    result = fromEnd ? result.slice(1) : result.slice(0, -1);
  }

  return result;
}

export async function truncateLargeInput(
  cwd: string,
  text: string,
  filename: string
): Promise<string> {
  if (Buffer.byteLength(text, 'utf-8') <= TRUNCATION_THRESHOLD_BYTES) {
    return text;
  }

  await writeContextFile(cwd, filename, text);

  const filePath = path.posix.join(PROTOCOL_INPUT_DIR, filename);
  const lines = text.split('\n');
  const headLines = lines.slice(0, TRUNCATION_HEAD_LINES);
  const tailLines = lines.slice(-TRUNCATION_TAIL_LINES);
  const omittedLineCount = lines.length - headLines.length - tailLines.length;

  if (omittedLineCount > 0) {
    return [
      headLines.join('\n'),
      `[${omittedLineCount} lines omitted; full output written to ${filePath}]`,
      tailLines.join('\n'),
    ].join('\n\n');
  }

  const head = truncateByBytes(text, TRUNCATION_HEAD_BYTES);
  const tail = truncateByBytes(text, TRUNCATION_TAIL_BYTES, true);
  const omittedBytes = Math.max(
    Buffer.byteLength(text, 'utf-8') -
      Buffer.byteLength(head, 'utf-8') -
      Buffer.byteLength(tail, 'utf-8'),
    0
  );

  return [head, `[${omittedBytes} bytes omitted; full output written to ${filePath}]`, tail].join(
    '\n\n'
  );
}

export async function executeTransition(
  repo: string,
  issueNumber: string,
  transition: LabelTransition
): Promise<void> {
  if (transition.add.length === 0 && transition.remove.length === 0) {
    return;
  }

  const args = ['issue', 'edit', issueNumber, '-R', repo];
  for (const label of transition.add) {
    args.push('--add-label', label);
  }
  for (const label of transition.remove) {
    args.push('--remove-label', label);
  }

  await gh(args);
}

export async function postComment(
  repo: string,
  issueNumber: string,
  commentFilePath: string
): Promise<void> {
  await gh(['issue', 'comment', issueNumber, '-R', repo, '--body-file', commentFilePath]);
}

export async function postReplies(
  repo: string,
  prNumber: string,
  cwd: string,
  repliesPath?: string
): Promise<void> {
  if (!repliesPath) {
    return;
  }

  const repliesDir = resolveOutputPath(cwd, repliesPath, 'replies path');
  let entries;
  try {
    entries = await readdir(repliesDir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const replyEntries = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => ({
      entry,
      commentId: entry.name.slice(0, -'.md'.length),
    }))
    .filter(({ commentId }) => /^\d+$/.test(commentId))
    .sort((a, b) => Number(a.commentId) - Number(b.commentId));

  for (const { entry, commentId } of replyEntries) {
    const body = await readFile(path.join(repliesDir, entry.name), 'utf-8');
    await gh([
      'api',
      `repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      '--method',
      'POST',
      '-f',
      `body=${body}`,
    ]);
  }
}

export async function createPrFromSpec(
  repo: string,
  cwd: string,
  specPath: string
): Promise<string | undefined> {
  const { spec } = await readPrSpec(cwd, specPath);

  const { stdout: existing } = await gh([
    'pr',
    'list',
    '-R',
    repo,
    '--head',
    spec.head_branch,
    '--json',
    'url',
    '-q',
    '.[0].url',
  ]);
  if (existing.trim()) {
    return existing.trim();
  }

  const bodyPath = resolveOutputPath(cwd, spec.body_file, 'PR body path');
  const args = [
    'pr',
    'create',
    '-R',
    repo,
    '--head',
    spec.head_branch,
    '--base',
    spec.base,
    '--title',
    spec.title,
    '--body-file',
    bodyPath,
  ];
  if (spec.draft) {
    args.push('--draft');
  }

  const { stdout } = await gh(args);
  return stdout.trim() || undefined;
}

export async function submitReviewPayload(
  repo: string,
  prNumber: string,
  cwd: string,
  payloadPath: string
): Promise<void> {
  const { abs, payload } = await readReviewPayload(cwd, payloadPath);

  const { stdout: viewer } = await gh(['api', 'user', '-q', '.login']);
  const { stdout: author } = await gh([
    'pr',
    'view',
    prNumber,
    '-R',
    repo,
    '--json',
    'author',
    '--jq',
    '.author.login',
  ]);

  if (viewer.trim() === author.trim() && payload.event !== 'COMMENT') {
    payload.event = 'COMMENT';
    await writeFile(abs, JSON.stringify(payload), 'utf-8');
  }

  await gh(['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--method', 'POST', '--input', abs]);
}

export async function validateStageOutput(cwd: string, stage: StageName): Promise<ResultJson> {
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
    await readReviewPayload(cwd, result.review_payload);
  }

  return result;
}

export async function processResult(opts: {
  repo: string;
  issueNumber: string;
  stage: StageName;
  cwd: string;
  result: ResultJson;
  prNumber?: string;
}): Promise<ResultJson> {
  const { result } = opts;
  const commentPath = resolveOutputPath(opts.cwd, result.comment, 'comment path');

  if (result.verdict === 'accept' && result.pr_spec) {
    await createPrFromSpec(opts.repo, opts.cwd, result.pr_spec);
  }

  if (result.verdict === 'accept' && result.review_payload) {
    if (!opts.prNumber) {
      throw new Error('review payload requires a PR number');
    }
    await submitReviewPayload(opts.repo, opts.prNumber, opts.cwd, result.review_payload);
  }

  await postComment(opts.repo, opts.issueNumber, commentPath);
  await executeTransition(
    opts.repo,
    opts.issueNumber,
    resolveTransition(opts.stage, result.verdict)
  );

  return result;
}

export async function retryOnInvalidOutput(opts: {
  cwd: string;
  stage: StageName;
  retry: (correctionMessage: string) => Promise<number>;
}): Promise<ResultJson> {
  try {
    return await validateStageOutput(opts.cwd, opts.stage);
  } catch (error) {
    const errors =
      error instanceof ResultValidationError
        ? error.errors
        : [error instanceof Error ? error.message : String(error)];
    await opts.retry(formatCorrectionMessage(errors));
    return await validateStageOutput(opts.cwd, opts.stage);
  }
}

export function formatCorrectionMessage(errors: string[]): string {
  return [
    'Your previous output was invalid. Fix the following and produce a valid .shipper/output/result.json:',
    ...errors.map((error) => `- ${error}`),
  ].join('\n');
}

export async function handleAgentCrash(
  repo: string,
  issueNumber: string,
  stage: StageName,
  errorDetail: string,
  summary = `The \`${stage}\` agent run exited without producing a valid \`.shipper/output/result.json\`.`
): Promise<void> {
  const body = ['## Agent Failure', '', summary, '', errorDetail].join('\n');

  await gh(['issue', 'comment', issueNumber, '-R', repo, '--body', body]);
}
