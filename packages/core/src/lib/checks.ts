import { toErrorMessage } from './errors.js';
import { gh } from './gh.js';
import { logger } from './logger.js';

export interface FailedStep {
  name: string;
}

export interface PRChecksLine {
  name: string;
  state: string;
  bucket: string;
  link?: string;
  failedSteps?: FailedStep[];
}

export interface CheckClassification {
  pending: PRChecksLine[];
  failed: PRChecksLine[];
  passed: PRChecksLine[];
  total: number;
}

interface RunViewStep {
  name: string;
  conclusion: string | null;
  number: number;
  status: string;
}

interface RunViewJob {
  name: string;
  conclusion: string | null;
  databaseId: number;
  steps: RunViewStep[];
}

export async function fetchChecks(repo: string, prNumber: string): Promise<PRChecksLine[]> {
  const { stdout } = await gh([
    'pr',
    'checks',
    prNumber,
    '-R',
    repo,
    '--json',
    'name,state,bucket,link',
  ]);
  return JSON.parse(stdout) as PRChecksLine[];
}

/**
 * Enriches failed checks in place with step-level failure details and returns full log dumps
 * keyed by unique, sanitized check names for artifact writing.
 */
export async function enrichFailedChecks(
  repo: string,
  failedChecks: PRChecksLine[]
): Promise<Map<string, string>> {
  const logDumps = new Map<string, string>();

  for (const check of failedChecks) {
    try {
      if (!check.link) {
        continue;
      }

      const runId = extractRunId(check.link);
      if (!runId) {
        continue;
      }

      const { stdout: jobsStdout } = await gh(['run', 'view', runId, '-R', repo, '--json', 'jobs']);
      const { jobs } = JSON.parse(jobsStdout) as { jobs: RunViewJob[] };
      const job = jobs.find((candidate) => candidate.name === check.name);
      if (!job) {
        continue;
      }

      const failedSteps = job.steps.filter((step) => step.conclusion === 'failure');
      if (failedSteps.length === 0) {
        continue;
      }

      const { stdout: logOutput } = await gh([
        'run',
        'view',
        '-R',
        repo,
        '--job',
        String(job.databaseId),
        '--log-failed',
      ]);
      check.failedSteps = failedSteps.map((step) => ({
        name: step.name,
      }));
      const logDumpName = createLogDumpName(check.name, job.databaseId, logDumps);
      logDumps.set(logDumpName, logOutput);
    } catch (error) {
      logger.warn(`Warning: Failed to enrich CI check "${check.name}": ${toErrorMessage(error)}`);
    }
  }

  return logDumps;
}

export async function rerunFailedChecks(repo: string, failedChecks: PRChecksLine[]): Promise<void> {
  const runIds = new Set<string>();

  for (const check of failedChecks) {
    if (!check.link) {
      continue;
    }

    const runId = extractRunId(check.link);
    if (runId) {
      runIds.add(runId);
    }
  }

  for (const runId of runIds) {
    try {
      await gh(['run', 'rerun', runId, '--failed', '-R', repo]);
    } catch (error) {
      logger.warn(`Warning: Failed to re-run workflow ${runId}: ${toErrorMessage(error)}`);
    }
  }
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

function extractRunId(link: string): string | null {
  const match = /\/actions\/runs\/(\d+)/.exec(link);
  return match?.[1] ?? null;
}

function sanitizeCheckName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function createLogDumpName(
  name: string,
  databaseId: number,
  existingLogDumps: Map<string, string>
): string {
  const sanitizedName = sanitizeCheckName(name) || 'check';
  if (!existingLogDumps.has(sanitizedName)) {
    return sanitizedName;
  }

  const databaseIdName = `${sanitizedName}-${databaseId}`;
  if (!existingLogDumps.has(databaseIdName)) {
    return databaseIdName;
  }

  let suffix = 2;
  while (existingLogDumps.has(`${databaseIdName}-${suffix}`)) {
    suffix += 1;
  }

  return `${databaseIdName}-${suffix}`;
}
