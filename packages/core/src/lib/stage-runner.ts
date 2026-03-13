import path from 'node:path';
import { gh } from './gh.js';
import { INPUT_DIR, OUTPUT_DIR, ensureDirectories, scrubOutputDir } from './output-dirs.js';
import { PostflightError, processResult } from './postflight.js';
import {
  InvalidResultError,
  MissingResultError,
  MissingResultFileError,
  type ResultValidationError,
} from './result-schema.js';
import { runPreflight } from './preflight.js';
import { runPrompt, type RunPromptOpts } from './prompt-runner.js';
import type { StageName } from './stage-transitions.js';

const MAX_RESULT_ATTEMPTS = 2;

export interface StageRunnerOpts {
  repo: string;
  issueRef: string;
  prRef?: string;
  cwd?: string;
  promptOpts: RunPromptOpts;
}

function appendCorrectionMessage(existing: string | undefined, correction: string): string {
  return existing ? `${existing}\n\n---\n\n${correction}` : correction;
}

function formatCorrectionMessage(error: ResultValidationError): string {
  return [
    'Your previous run did not produce a valid .shipper/output/result.json.',
    `Error: ${error.message}`,
    'You must write a valid result.json to .shipper/output/result.json before exiting.',
  ].join(' ');
}

function isRetryableResultError(
  error: unknown
): error is MissingResultError | InvalidResultError | MissingResultFileError {
  return (
    error instanceof MissingResultError ||
    error instanceof InvalidResultError ||
    error instanceof MissingResultFileError
  );
}

async function postRetryableFailureComment(
  stage: StageName,
  error: unknown,
  opts: StageRunnerOpts
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await gh(
      [
        'issue',
        'comment',
        opts.issueRef,
        '-R',
        opts.repo,
        '--body',
        `Automated ${stage} failed: agent exited without producing a valid result. The issue remains at its current stage and is eligible for retry.\n\nLast validation error: ${message}`,
      ],
      { cwd: opts.cwd }
    );
  } catch (commentError) {
    const reason = commentError instanceof Error ? commentError.message : String(commentError);
    throw new PostflightError(`Posting retryable failure comment failed: ${reason}`);
  }
}

export async function runStageWithProtocol(
  stage: StageName,
  opts: StageRunnerOpts
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const inputDir = path.resolve(cwd, INPUT_DIR);
  const outputDir = path.resolve(cwd, OUTPUT_DIR);

  await ensureDirectories(cwd);
  await scrubOutputDir(cwd);
  await runPreflight(stage, {
    repo: opts.repo,
    issueRef: opts.issueRef,
    prRef: opts.prRef,
    inputDir,
  });

  let promptOpts = { ...opts.promptOpts };
  let lastExitCode = 1;
  let lastResultError: ResultValidationError | undefined;

  for (let attempt = 1; attempt <= MAX_RESULT_ATTEMPTS; attempt++) {
    lastExitCode = await runPrompt(stage, { ...promptOpts, cwd });

    try {
      await processResult(stage, {
        repo: opts.repo,
        issueRef: opts.issueRef,
        prRef: opts.prRef,
        outputDir,
        cwd,
      });
      return 0;
    } catch (error) {
      if (error instanceof PostflightError) {
        throw error;
      }

      if (!isRetryableResultError(error)) {
        throw error;
      }

      lastResultError = error;
      if (attempt === MAX_RESULT_ATTEMPTS) {
        break;
      }

      await scrubOutputDir(cwd);
      promptOpts = {
        ...promptOpts,
        cwd,
        userInput: appendCorrectionMessage(promptOpts.userInput, formatCorrectionMessage(error)),
      };
    }
  }

  await postRetryableFailureComment(
    stage,
    lastResultError ?? new MissingResultError('Missing result.json'),
    opts
  );
  return lastExitCode || 1;
}
