import { mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gh } from './gh.js';
import { readResultFile, type ResultJson } from './result-schema.js';
import { resolveTransition, type LabelTransition, type StageName } from './stage-transitions.js';

export const PROTOCOL_INPUT_DIR = path.join('.shipper', 'input');
export const PROTOCOL_OUTPUT_DIR = path.join('.shipper', 'output');

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
  const filePath = path.resolve(cwd, PROTOCOL_INPUT_DIR, filename);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
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

export async function processResult(opts: {
  repo: string;
  issueNumber: string;
  stage: StageName;
  cwd: string;
}): Promise<ResultJson> {
  const result = await readResultFile(path.resolve(opts.cwd, PROTOCOL_OUTPUT_DIR));
  const commentPath = path.resolve(opts.cwd, result.comment);

  await postComment(opts.repo, opts.issueNumber, commentPath);
  await executeTransition(
    opts.repo,
    opts.issueNumber,
    resolveTransition(opts.stage, result.verdict)
  );

  return result;
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
  stage: string,
  errorDetail: string
): Promise<void> {
  const body = [
    '## Agent Failure',
    '',
    `The \`${stage}\` agent run exited without producing a valid \`.shipper/output/result.json\`.`,
    '',
    errorDetail,
  ].join('\n');

  await gh(['issue', 'comment', issueNumber, '-R', repo, '--body', body]);
}
