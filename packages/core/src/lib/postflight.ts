import { readFile } from 'node:fs/promises';
import { BLOCKED_LABEL, FAILED_LABEL, STAGE_LABEL_NAMES } from './labels.js';
import { gh } from './gh.js';
import { RESULT_FILENAME } from './output-dirs.js';
import {
  MissingResultError,
  parsePrSpec,
  parseReplies,
  parseReviewPayload,
  resolveOutputPath,
  validateResult,
  validateResultFiles,
  type StageResult,
} from './result-schema.js';
import { resolveTransition, type LabelTransition, type StageName } from './stage-transitions.js';

export interface PostflightOpts {
  repo: string;
  issueRef: string;
  prRef?: string;
  outputDir: string;
  cwd?: string;
}

type PostProcessor = (result: StageResult, opts: PostflightOpts) => Promise<void>;

export class PostflightError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'PostflightError';
  }
}

function requirePrRef(opts: PostflightOpts, stage: StageName): string {
  if (!opts.prRef) {
    throw new PostflightError(`Stage "${stage}" requires opts.prRef for post-flight processing.`);
  }

  return opts.prRef;
}

function formatGhError(action: string, error: unknown): PostflightError {
  const message = error instanceof Error ? error.message : String(error);
  return new PostflightError(`${action} failed: ${message}`);
}

function requireField(field: keyof StageResult, result: StageResult, message: string): void {
  if (!result[field]) {
    throw new PostflightError(message);
  }
}

async function getCurrentWorkflowLabel(
  repo: string,
  issueRef: string
): Promise<string | undefined> {
  let stdout: string;
  try {
    const result = await gh([
      'issue',
      'view',
      issueRef,
      '-R',
      repo,
      '--json',
      'labels',
      '--jq',
      '.labels[].name',
    ]);
    stdout = result.stdout.trim();
  } catch (error) {
    throw formatGhError(`Resolving current labels for issue ${issueRef}`, error);
  }

  if (!stdout) {
    return undefined;
  }

  const labels = stdout
    .split(/\r?\n/)
    .filter((name) => name.startsWith('shipper:') && name !== BLOCKED_LABEL);

  if (labels.includes(FAILED_LABEL)) {
    return FAILED_LABEL;
  }

  const stageLabels = labels.filter((label) => STAGE_LABEL_NAMES.includes(label));
  return stageLabels.length === 1 ? stageLabels[0] : undefined;
}

async function postIssueComment(result: StageResult, opts: PostflightOpts): Promise<void> {
  const commentPath = resolveOutputPath(opts.outputDir, result.comment);

  try {
    await gh(['issue', 'comment', opts.issueRef, '-R', opts.repo, '--body-file', commentPath], {
      cwd: opts.cwd,
    });
  } catch (error) {
    throw formatGhError(`Posting issue comment for ${opts.issueRef}`, error);
  }
}

async function applyLabelTransition(
  transition: LabelTransition,
  repo: string,
  issueRef: string,
  cwd?: string
): Promise<void> {
  if (transition.add.length === 0 && transition.remove.length === 0) {
    return;
  }

  const args = ['issue', 'edit', issueRef, '-R', repo];
  for (const label of transition.add) {
    args.push('--add-label', label);
  }
  for (const label of transition.remove) {
    args.push('--remove-label', label);
  }

  try {
    await gh(args, { cwd });
  } catch (error) {
    throw formatGhError(`Updating labels for issue ${issueRef}`, error);
  }
}

const POST_PROCESSORS: Partial<Record<StageName, PostProcessor>> = {
  async pr_open(result, opts) {
    requireField('pr_spec', result, 'result.pr_spec is required for pr_open accept.');
    const spec = await parsePrSpec(opts.outputDir, result);
    const bodyPath = resolveOutputPath(opts.outputDir, spec.body);
    const args = [
      'pr',
      'create',
      '-R',
      opts.repo,
      '--base',
      spec.base,
      '--title',
      spec.title,
      '--body-file',
      bodyPath,
    ];
    if (spec.head) {
      args.push('--head', spec.head);
    }
    if (spec.draft) {
      args.push('--draft');
    }

    try {
      await gh(args, { cwd: opts.cwd });
    } catch (error) {
      throw formatGhError('Creating pull request', error);
    }
  },

  async pr_review(result, opts) {
    requireField(
      'review_payload',
      result,
      'result.review_payload is required for pr_review accept.'
    );
    const prRef = requirePrRef(opts, 'pr_review');
    const { payloadPath } = await parseReviewPayload(opts.outputDir, result);

    try {
      await gh(
        [
          'api',
          `repos/${opts.repo}/pulls/${prRef}/reviews`,
          '--method',
          'POST',
          '--input',
          payloadPath,
        ],
        { cwd: opts.cwd }
      );
    } catch (error) {
      throw formatGhError(`Submitting review for PR ${prRef}`, error);
    }
  },

  async pr_remediate(result, opts) {
    const prRef = requirePrRef(opts, 'pr_remediate');
    const replies = await parseReplies(opts.outputDir, result);

    for (const reply of replies) {
      const body = await readFile(reply.path, 'utf-8');
      try {
        await gh(
          [
            'api',
            `repos/${opts.repo}/pulls/${prRef}/comments/${reply.commentId}/replies`,
            '--method',
            'POST',
            '-f',
            `body=${body}`,
          ],
          { cwd: opts.cwd }
        );
      } catch (error) {
        throw formatGhError(`Posting reply for review comment ${reply.commentId}`, error);
      }
    }
  },
};

function validateStageRequirements(stage: StageName, result: StageResult): void {
  if (stage === 'pr_open' && result.verdict === 'accept') {
    requireField('pr_spec', result, 'result.pr_spec is required for pr_open accept.');
  }

  if (stage === 'pr_review' && result.verdict === 'accept') {
    requireField(
      'review_payload',
      result,
      'result.review_payload is required for pr_review accept.'
    );
  }
}

export async function processResult(stage: StageName, opts: PostflightOpts): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(resolveOutputPath(opts.outputDir, RESULT_FILENAME), 'utf-8');
  } catch {
    throw new MissingResultError(`Missing ${RESULT_FILENAME} in ${opts.outputDir}`);
  }

  const result = validateResult(raw);
  await validateResultFiles(opts.outputDir, result);
  validateStageRequirements(stage, result);

  await postIssueComment(result, opts);

  if (result.verdict === 'accept') {
    const processor = POST_PROCESSORS[stage];
    if (processor) {
      await processor(result, opts);
    }
  }

  const currentWorkflowLabel =
    stage === 'unblock' ? await getCurrentWorkflowLabel(opts.repo, opts.issueRef) : undefined;
  const transition = resolveTransition(stage, result.verdict, currentWorkflowLabel);
  await applyLabelTransition(transition, opts.repo, opts.issueRef, opts.cwd);
}
