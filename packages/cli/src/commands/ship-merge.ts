import type { WriteStream } from 'node:fs';
import { executeMerge, gh } from '@dnsquared/shipper-core';
import type { Logger, QueuedPR } from '@dnsquared/shipper-core';

const MERGE_FAILURE_PREFIX = 'Merge failed for PR #';

export function isRetriableMergeFailure(error?: string): boolean {
  return error?.includes(MERGE_FAILURE_PREFIX) ?? false;
}

export async function resolvePrForIssue(issueNumber: number, nwo: string): Promise<QueuedPR> {
  let output: string;
  try {
    const result = await gh([
      'pr',
      'list',
      '-R',
      nwo,
      '--state',
      'open',
      '--json',
      'number,title,headRefName,baseRefName',
    ]);
    output = result.stdout;
  } catch {
    throw new Error(`Failed to look up PRs for issue #${issueNumber}.`);
  }

  let allPrs: QueuedPR[];
  try {
    allPrs = JSON.parse(output) as QueuedPR[];
  } catch {
    throw new Error(
      `Failed to parse GitHub CLI output while looking up PR for issue #${issueNumber}.`
    );
  }

  const prs = allPrs.filter(
    (pr) =>
      pr.headRefName === `shipper/${issueNumber}` ||
      pr.headRefName.startsWith(`shipper/${issueNumber}-`)
  );

  if (prs.length === 0) {
    throw new Error(`No open PR found for issue #${issueNumber}.`);
  }

  if (prs.length > 1) {
    const prNumbers = prs.map((pr) => `#${pr.number}`).join(', ');
    throw new Error(
      `Multiple open PRs found for issue #${issueNumber}: ${prNumbers}. Please ensure only one is open.`
    );
  }

  const pr = prs[0];
  if (!pr) {
    throw new Error(`No open PR found for issue #${issueNumber}.`);
  }

  return { ...pr, labeledAt: '' };
}

export async function mergePr(
  pr: QueuedPR,
  issueNumber: number,
  nwo: string,
  issueLogger: Logger,
  logStream?: WriteStream
): Promise<void> {
  await executeMerge({
    pr,
    issueNumber,
    nwo,
    logger: issueLogger,
    logStream,
    treatPendingChecksAsFailure: true,
  });
}
