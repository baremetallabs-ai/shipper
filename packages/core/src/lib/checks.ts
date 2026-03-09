import { gh } from './gh.js';

export interface PRChecksLine {
  name: string;
  state: string;
  bucket: string;
}

export interface CheckClassification {
  pending: PRChecksLine[];
  failed: PRChecksLine[];
  passed: PRChecksLine[];
  total: number;
}

export async function fetchChecks(prNumber: string, nwo?: string): Promise<PRChecksLine[]> {
  const args = ['pr', 'checks', prNumber, '--json', 'name,state,bucket'];
  if (nwo) {
    args.push('-R', nwo);
  }
  const { stdout } = await gh(args);
  return JSON.parse(stdout) as PRChecksLine[];
}

export function classifyChecks(checks: PRChecksLine[]): CheckClassification {
  const pending: PRChecksLine[] = [];
  const failed: PRChecksLine[] = [];
  const passed: PRChecksLine[] = [];

  for (const check of checks) {
    if (check.bucket === 'pending') {
      pending.push(check);
    } else if (check.bucket === 'fail' || check.bucket === 'cancel') {
      failed.push(check);
    } else {
      passed.push(check);
    }
  }

  return { pending, failed, passed, total: checks.length };
}
