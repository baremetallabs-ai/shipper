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
];

function isPermanent(stderr: string): boolean {
  return PERMANENT_PATTERNS.some((pattern) => pattern.test(stderr));
}

function getErrorStderr(err: unknown): string {
  return typeof err === 'object' &&
    err !== null &&
    'stderr' in err &&
    typeof err.stderr === 'string'
    ? err.stderr
    : '';
}

function isMissingBinary(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
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

export async function gh(
  args: string[],
  options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  let firstError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await execFileAsync('gh', args, {
        encoding: 'utf-8',
        ...options,
      });
    } catch (err) {
      firstError ??= err;
      const stderr = getErrorStderr(err);

      if (isPermanent(stderr) || isMissingBinary(err)) {
        throw err;
      }

      if (attempt === MAX_ATTEMPTS) {
        throw firstError;
      }

      const command = formatCommandForLog(args);
      const reason = formatStderrForLog(stderr);
      logger.error(
        `${command} failed${reason ? `: ${reason}` : ''}, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`
      );
      await sleepMs(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw firstError;
}
