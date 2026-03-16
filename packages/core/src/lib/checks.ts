import { gh } from './gh.js';

export interface FailedStep {
  name: string;
  logSnippet: string;
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
      const stepLogs = parseStepLogs(logOutput);
      const fallbackSnippet = lastNLines(logOutput, 50);

      check.failedSteps = failedSteps.map((step) => ({
        name: step.name,
        logSnippet: lastNLines(stepLogs.get(step.name) ?? fallbackSnippet, 50),
      }));
      logDumps.set(sanitizeCheckName(check.name), logOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Failed to enrich CI check "${check.name}": ${message}`);
    }
  }

  return logDumps;
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

function parseStepLogs(logOutput: string): Map<string, string> {
  const stepLogs = new Map<string, string>();

  for (const line of logOutput.split('\n')) {
    if (!line) {
      continue;
    }

    const firstTab = line.indexOf('\t');
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      continue;
    }

    const stepName = line.slice(firstTab + 1, secondTab);
    const content = line.slice(secondTab + 1);
    const existing = stepLogs.get(stepName);
    stepLogs.set(stepName, existing ? `${existing}\n${content}` : content);
  }

  return stepLogs;
}

function lastNLines(text: string, n: number): string {
  if (!text) {
    return '';
  }

  return text.split('\n').slice(-n).join('\n');
}
