import type { WriteStream } from 'node:fs';
import {
  classifyChecks,
  fetchChecks,
  gh,
  PR_REVIEWED_LABEL,
  READY_LABEL,
  sleepMs,
  toErrorMessage,
} from '@dnsquared/shipper-core';
import type { Logger } from '@dnsquared/shipper-core';
import { pollPrMerged, postMerge } from './merge.js';
import type { QueuedPR } from './merge.js';

interface PRMergeStateViewData {
  mergeStateStatus: string;
  mergeable: string;
}

const MERGE_FAILURE_PREFIX = 'Merge failed for PR #';
const UNKNOWN_STATE_POLL_MAX = 5;
const UNKNOWN_STATE_POLL_DELAY_MS = 3_000;

function writeStdoutBoth(logStream: WriteStream | undefined, chunk: string | Buffer): void {
  process.stdout.write(chunk);
  logStream?.write(chunk);
}

function formatMergeFailureMessage(prNumber: number, reason: string): string {
  const prefix = `${MERGE_FAILURE_PREFIX}${prNumber}:`;
  return reason.startsWith(prefix) ? reason : `${prefix} ${reason}`;
}

function isMergeReadyState(mergeState: string): boolean {
  return mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS' || mergeState === 'UNSTABLE';
}

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

async function getMergeStateStatus(prNumber: number, nwo: string): Promise<string> {
  let output: string;
  try {
    const result = await gh([
      'pr',
      'view',
      String(prNumber),
      '-R',
      nwo,
      '--json',
      'mergeStateStatus,mergeable',
    ]);
    output = result.stdout;
  } catch (err) {
    throw new Error(`Could not determine merge state for PR #${prNumber}: ${toErrorMessage(err)}`);
  }

  try {
    const data = JSON.parse(output) as PRMergeStateViewData;

    // GitHub may not compute mergeStateStatus when branch protection is absent,
    // leaving it permanently UNKNOWN. Fall back to the mergeable field which is
    // computed independently.
    if (data.mergeStateStatus === 'UNKNOWN' && data.mergeable === 'MERGEABLE') {
      return 'CLEAN';
    }

    return data.mergeStateStatus;
  } catch (err) {
    throw new Error(`Could not determine merge state for PR #${prNumber}: ${toErrorMessage(err)}`);
  }
}

async function getBlockedMergeStateReason(pr: QueuedPR, nwo: string): Promise<string> {
  let checks;
  try {
    checks = await fetchChecks(nwo, String(pr.number));
  } catch (err) {
    throw new Error(`Could not fetch CI checks for PR #${pr.number}: ${toErrorMessage(err)}`);
  }

  const { pending, failed } = classifyChecks(checks);

  if (failed.length > 0) {
    const names = failed.map((check) => check.name).join(', ');
    return `PR #${pr.number} is blocked by failed CI checks: ${names}.`;
  }

  if (pending.length > 0) {
    const names = pending.map((check) => check.name).join(', ');
    return `PR #${pr.number} is blocked by pending CI checks: ${names}. Retry when they complete.`;
  }

  return `PR #${pr.number} is blocked, likely due to required reviews or branch protection requirements.`;
}

async function getMergeStateFailureReason(
  pr: QueuedPR,
  nwo: string,
  mergeState: string,
  afterRebase = false
): Promise<string> {
  if (mergeState === 'BEHIND') {
    if (afterRebase) {
      return `PR #${pr.number} is still behind its base branch after rebasing. Retry shortly.`;
    }

    return `PR #${pr.number} is behind its base branch and must be rebased before merging.`;
  }

  if (mergeState === 'DIRTY') {
    return `PR #${pr.number} has merge conflicts that must be resolved.`;
  }

  if (mergeState === 'BLOCKED') {
    return await getBlockedMergeStateReason(pr, nwo);
  }

  if (mergeState === 'UNKNOWN') {
    return `GitHub has not computed merge state for PR #${pr.number} yet. Retry shortly.`;
  }

  return `Unrecognized merge state '${mergeState}' for PR #${pr.number}.`;
}

async function remediateMergeFailure(
  pr: QueuedPR,
  issueNumber: number,
  nwo: string,
  reason: string,
  issueLogger: Logger
): Promise<void> {
  issueLogger.error(`\n${formatMergeFailureMessage(pr.number, reason)}`);

  try {
    await gh([
      'pr',
      'edit',
      String(pr.number),
      '-R',
      nwo,
      '--remove-label',
      READY_LABEL,
      '--add-label',
      PR_REVIEWED_LABEL,
    ]);
  } catch {
    issueLogger.error(`Warning: Failed to update labels on PR #${pr.number}`);
  }

  try {
    await gh([
      'issue',
      'edit',
      String(issueNumber),
      '-R',
      nwo,
      '--remove-label',
      READY_LABEL,
      '--add-label',
      PR_REVIEWED_LABEL,
    ]);
  } catch {
    issueLogger.error(`Warning: Failed to update labels on issue #${issueNumber}`);
  }

  const comment = [
    `Merge failed for PR #${pr.number}.`,
    '',
    `**Reason:** ${reason}`,
    '',
    `The \`${PR_REVIEWED_LABEL}\` label has been re-applied so the PR can be remediated and re-queued.`,
  ].join('\n');

  try {
    await gh(['pr', 'comment', String(pr.number), '-R', nwo, '--body', comment]);
  } catch {
    issueLogger.error(`Warning: Failed to post failure comment on PR #${pr.number}`);
  }
}

export async function mergePr(
  pr: QueuedPR,
  issueNumber: number,
  nwo: string,
  issueLogger: Logger,
  logStream?: WriteStream
): Promise<void> {
  const completePostMerge = async (message: string): Promise<void> => {
    issueLogger.log(message);
    await postMerge(pr, issueNumber, nwo, false);
  };

  try {
    let mergeState = await getMergeStateStatus(pr.number, nwo);
    let rebased = false;

    if (mergeState === 'BEHIND') {
      issueLogger.log(`PR #${pr.number} is behind its base branch. Rebasing before merge.`);
      try {
        const { stdout } = await gh([
          'pr',
          'update-branch',
          String(pr.number),
          '-R',
          nwo,
          '--rebase',
        ]);
        if (stdout.trim()) {
          writeStdoutBoth(logStream, stdout);
        }
      } catch (err) {
        throw new Error(
          `Failed to rebase PR #${pr.number} onto its base branch: ${toErrorMessage(err)}`
        );
      }

      rebased = true;
      mergeState = await getMergeStateStatus(pr.number, nwo);
    }

    if (mergeState === 'UNKNOWN') {
      issueLogger.log(`PR #${pr.number} merge state is UNKNOWN. Polling for resolution...`);
      for (let i = 0; i < UNKNOWN_STATE_POLL_MAX && mergeState === 'UNKNOWN'; i++) {
        await sleepMs(UNKNOWN_STATE_POLL_DELAY_MS);
        mergeState = await getMergeStateStatus(pr.number, nwo);
      }
    }

    if (!isMergeReadyState(mergeState)) {
      throw new Error(await getMergeStateFailureReason(pr, nwo, mergeState, rebased));
    }

    try {
      const { stdout } = await gh([
        'pr',
        'merge',
        String(pr.number),
        '-R',
        nwo,
        '--rebase',
        '--delete-branch',
      ]);
      if (stdout.trim()) {
        writeStdoutBoth(logStream, stdout);
      }
      await completePostMerge(`PR #${pr.number} merged successfully.`);
      return;
    } catch (err) {
      const merged = await pollPrMerged(pr.number, nwo);
      if (merged) {
        await completePostMerge(
          `PR #${pr.number} merge succeeded despite reported error. Proceeding with post-merge cleanup.`
        );
        return;
      }
      throw err;
    }
  } catch (err) {
    const reason = toErrorMessage(err);
    await remediateMergeFailure(pr, issueNumber, nwo, reason, issueLogger);
    throw new Error(formatMergeFailureMessage(pr.number, reason));
  }
}
