import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { toErrorMessage } from '../errors.js';
import { gh } from '../gh.js';
import { logger } from '../logger.js';
import type { ResultJson } from '../result-schema.js';
import { resolveTransition, type LabelTransition, type StageName } from '../stage-transitions.js';
import { resolveOutputPath } from './protocol-io.js';
import { readPrSpec, readReviewPayload } from './protocol-validation.js';

const PR_MIRROR_STAGES = new Set<StageName>(['pr_open', 'pr_review', 'pr_remediate']);

export interface PrSpecResult {
  url: string;
  number: number;
}

function parsePrNumberFromUrl(url: string): number {
  const pathname = new URL(url).pathname;
  const match = /\/pull\/(\d+)\/?$/.exec(pathname);
  const prNumber = Number(match?.[1]);

  if (!match?.[1] || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Failed to parse PR number from URL: ${url}`);
  }

  return prNumber;
}

export async function executeTransition(
  repo: string,
  issueNumber: string,
  transition: LabelTransition,
  prNumber?: string
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

  if (!prNumber) {
    return;
  }

  const prArgs = ['pr', 'edit', prNumber, '-R', repo];
  for (const label of transition.add) {
    prArgs.push('--add-label', label);
  }
  for (const label of transition.remove) {
    prArgs.push('--remove-label', label);
  }

  try {
    await gh(prArgs);
  } catch (error) {
    logger.warn(
      `Warning: Failed to mirror transition labels onto PR #${prNumber}: ${toErrorMessage(error)}`
    );
  }
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
  const result = await createPrFromSpecWithMetadata(repo, cwd, specPath);
  return result?.url;
}

export async function createPrFromSpecWithMetadata(
  repo: string,
  cwd: string,
  specPath: string
): Promise<PrSpecResult | undefined> {
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
    const url = existing.trim();
    return { url, number: parsePrNumberFromUrl(url) };
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
  const url = stdout.trim();
  if (!url) {
    return undefined;
  }

  return { url, number: parsePrNumberFromUrl(url) };
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

export async function processResult(opts: {
  repo: string;
  issueNumber: string;
  stage: StageName;
  cwd: string;
  result: ResultJson;
  prNumber?: string;
}): Promise<ResultJson> {
  if (opts.stage === 'groom') {
    throw new Error('groom results must be processed with processGroomResult');
  }

  const { result } = opts;
  const commentPath = resolveOutputPath(opts.cwd, result.comment, 'comment path');
  let createdPr: PrSpecResult | undefined;

  if (result.verdict === 'accept' && result.pr_spec) {
    createdPr = await createPrFromSpecWithMetadata(opts.repo, opts.cwd, result.pr_spec);
  }

  if (result.verdict === 'accept' && result.review_payload) {
    if (!opts.prNumber) {
      throw new Error('review payload requires a PR number');
    }
    await submitReviewPayload(opts.repo, opts.prNumber, opts.cwd, result.review_payload);
  }

  await postComment(opts.repo, opts.issueNumber, commentPath);
  const mirrorPrNumber = PR_MIRROR_STAGES.has(opts.stage)
    ? (createdPr?.number.toString() ?? opts.prNumber)
    : undefined;
  await executeTransition(
    opts.repo,
    opts.issueNumber,
    resolveTransition(opts.stage, result.verdict),
    mirrorPrNumber
  );

  return result;
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
