import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sleepMs } from './sleep.js';

const execFileAsync = promisify(execFile);

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

const PERMANENT_PATTERNS = [
  /HTTP 401/i,
  /HTTP 404/i,
  /HTTP 422/i,
  /not found/i,
  /could not resolve to a/i,
  /validation failed/i,
];

function isPermanent(stderr: string): boolean {
  return PERMANENT_PATTERNS.some((pattern) => pattern.test(stderr));
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

      const stderr =
        typeof err === 'object' && err !== null && 'stderr' in err && typeof err.stderr === 'string'
          ? err.stderr
          : '';

      if (isPermanent(stderr)) {
        throw err;
      }

      if (attempt === MAX_ATTEMPTS) {
        throw firstError;
      }

      console.error(`gh call failed, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
      await sleepMs(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw firstError;
}
