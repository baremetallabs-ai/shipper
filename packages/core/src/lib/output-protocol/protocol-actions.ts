import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gh } from '../gh.js';
import type { ResultJson } from '../result-schema.js';
import { resolveTransition, type LabelTransition, type StageName } from '../stage-transitions.js';
import { resolveOutputPath } from './protocol-io.js';
import { readPrSpec, readReviewPayload } from './protocol-validation.js';

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
