import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { logger } from './logger.js';
import { sleepMs } from './sleep.js';

const execFileAsync = promisify(execFile);

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const UNQUOTED_ARG_PATTERN = /^[A-Za-z0-9_./:=,@-]+$/;

const PERMANENT_PATTERNS = [
  /HTTP 401/i,
  /HTTP 404/i,
  /HTTP 422/i,
  /could not resolve to a/i,
  /validation failed/i,
  /no commit found/i,
  /already in progress/i,
  /must be run in a work tree/i,
];

const RECOVERABLE_REVIEW_SUBMISSION_PATTERNS = [/HTTP 422/i, /validation failed/i];

const NON_RECOVERABLE_REVIEW_SUBMISSION_PATTERNS = [
  /HTTP 401/i,
  /HTTP 403/i,
  /HTTP 404/i,
  /bad credentials/i,
  /authentication/i,
  /authorization/i,
  /forbidden/i,
  /unauthorized/i,
  /not found/i,
  /could not resolve/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /network/i,
  /timed out/i,
  /timeout/i,
  /connection/i,
  /TLS/i,
  /proxy/i,
  /spawn gh/i,
];

function isPermanent(detail: string): boolean {
  return PERMANENT_PATTERNS.some((pattern) => pattern.test(detail));
}

function getErrorStderr(err: unknown): string {
  return typeof err === 'object' &&
    err !== null &&
    'stderr' in err &&
    (typeof err.stderr === 'string' || Buffer.isBuffer(err.stderr))
    ? String(err.stderr)
    : '';
}

function getErrorStdout(err: unknown): string {
  return typeof err === 'object' &&
    err !== null &&
    'stdout' in err &&
    (typeof err.stdout === 'string' || Buffer.isBuffer(err.stdout))
    ? String(err.stdout)
    : '';
}

function getErrorCode(err: unknown): string | number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err;
    if (typeof code === 'string' || typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}

function getErrorSignal(err: unknown): string | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'signal' in err &&
    typeof err.signal === 'string'
  ) {
    return err.signal;
  }
  return undefined;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : '';
}

function isMissingBinary(err: unknown): boolean {
  return getErrorCode(err) === 'ENOENT';
}

function formatArgForLog(arg: string): string {
  return UNQUOTED_ARG_PATTERN.test(arg) ? arg : JSON.stringify(arg);
}

function formatCommandForLog(args: string[]): string {
  return `gh ${args.map(formatArgForLog).join(' ')}`;
}

function formatStderrForLog(stderr: string): string {
  return stderr.trim().replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}

function formatExitDetail(code: string | number | undefined, signal: string | undefined): string {
  if (code !== undefined) {
    return `code ${code}`;
  }
  if (signal) {
    return `signal ${signal}`;
  }
  return '';
}

function formatGhErrorMessage(args: string[], err: unknown): string {
  const command = formatCommandForLog(args);
  const stderr = getErrorStderr(err).trim();
  const stdout = getErrorStdout(err).trim();
  const fallbackMessage = getErrorMessage(err).trim();
  const statusLine = firstLine(stderr) || firstLine(fallbackMessage);
  const exitDetail = formatExitDetail(getErrorCode(err), getErrorSignal(err));
  const header = `${command} failed${exitDetail ? ` (${exitDetail})` : ''}${
    statusLine ? `: ${statusLine}` : ''
  }`;
  const sections = [header];

  if (stderr) {
    sections.push('', 'stderr:', stderr);
  }
  if (stdout) {
    sections.push('', 'stdout:', stdout);
  }

  return sections.join('\n');
}

type GhErrorLike = Error & {
  args: string[];
  command: string;
  stdout: string;
  stderr: string;
  code?: string | number;
  signal?: string;
};

function getGhDiagnosticDetail(error: GhErrorLike): string {
  return [error.stderr, error.stdout]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n\n');
}

export class GhError extends Error {
  readonly args: string[];
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: string | number | undefined;
  readonly signal: string | undefined;

  constructor(args: string[], cause: unknown) {
    super(formatGhErrorMessage(args, cause), { cause });
    this.name = 'GhError';
    this.args = [...args];
    this.command = formatCommandForLog(args);
    this.stdout = getErrorStdout(cause);
    this.stderr = getErrorStderr(cause);
    this.code = getErrorCode(cause);
    this.signal = getErrorSignal(cause);
  }
}

export function isGhError(error: unknown): error is GhErrorLike {
  if (error instanceof GhError) {
    return true;
  }
  if (!(error instanceof Error) || error.name !== 'GhError') {
    return false;
  }
  const maybe = error as unknown as Record<string, unknown>;
  return (
    Array.isArray(maybe.args) &&
    maybe.args.every((arg) => typeof arg === 'string') &&
    typeof maybe.command === 'string' &&
    typeof maybe.stdout === 'string' &&
    typeof maybe.stderr === 'string' &&
    (maybe.code === undefined ||
      typeof maybe.code === 'string' ||
      typeof maybe.code === 'number') &&
    (maybe.signal === undefined || typeof maybe.signal === 'string')
  );
}

export function getGhErrorDetail(error: unknown): string {
  if (isGhError(error)) {
    return error.message;
  }
  return getErrorMessage(error) || String(error);
}

export function isRecoverableReviewSubmissionGhError(error: unknown): boolean {
  if (!isGhError(error) || error.code === 'ENOENT') {
    return false;
  }
  const detail = getGhDiagnosticDetail(error);
  if (NON_RECOVERABLE_REVIEW_SUBMISSION_PATTERNS.some((pattern) => pattern.test(detail))) {
    return false;
  }
  return RECOVERABLE_REVIEW_SUBMISSION_PATTERNS.some((pattern) => pattern.test(detail));
}

export async function gh(
  args: string[],
  options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  return await ghImpl(args, options);
}

async function ghDefault(
  args: string[],
  options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await execFileAsync('gh', args, {
        encoding: 'utf-8',
        ...options,
      });
    } catch (err) {
      lastError = err;
      const stderr = getErrorStderr(err);
      const stdout = getErrorStdout(err);
      const detail = [stderr, stdout].filter(Boolean).join('\n');

      if (isPermanent(detail) || isMissingBinary(err)) {
        throw new GhError(args, err);
      }

      if (attempt === MAX_ATTEMPTS) {
        throw new GhError(args, err);
      }

      const command = formatCommandForLog(args);
      const reason = formatStderrForLog(stderr);
      logger.error(
        `${command} failed${reason ? `: ${reason}` : ''}, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`
      );
      await sleepMs(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw new GhError(args, lastError);
}

let ghImpl: typeof ghDefault = ghDefault;

export function __setGhImpl(next?: typeof ghDefault): typeof ghDefault {
  const previous = ghImpl;
  ghImpl = next ?? ghDefault;
  return previous;
}
