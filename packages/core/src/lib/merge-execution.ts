import type { Writable } from 'node:stream';
import { classifyChecks, fetchChecks } from './checks.js';
import { toErrorMessage } from './errors.js';
import { gh } from './gh.js';
import { parsePrBodyView, parsePrMergeStateView, parsePrStateView } from './gh-schemas.js';
import { withStageHooks } from './hooks.js';
import { PR_REVIEWED_LABEL, READY_LABEL } from './labels.js';
import type { Logger } from './logger.js';
import { logger } from './logger.js';
import { getSettings } from './settings.js';
import { sleepMs } from './sleep.js';

export interface QueuedPR {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  labeledAt: string;
}

export interface ExecuteMergeOptions {
  pr: QueuedPR;
  issueNumber: number;
  nwo: string;
  logger: Logger;
  logStream?: Writable;
  treatPendingChecksAsFailure: boolean;
}

interface BlockedMergeState {
  kind: 'failed' | 'pending' | 'blocked';
  reason: string;
}

const UNKNOWN_STATE_POLL_MAX = 5;
const UNKNOWN_STATE_POLL_DELAY_MS = 3_000;
const MERGE_POLL_MAX_ATTEMPTS = 5;
const MERGE_POLL_BASE_DELAY_MS = 1_000;

function writeStdoutBoth(logStream: Writable | undefined, chunk: string | Buffer): void {
  process.stdout.write(chunk);
  logStream?.write(chunk);
}

function formatFailureComment(prNumber: number, reason: string): string {
  return [
    `Merge failed for PR #${prNumber}.`,
    '',
    `**Reason:** ${reason}`,
    '',
    `The \`${PR_REVIEWED_LABEL}\` label has been re-applied so the PR can be remediated and re-queued.`,
  ].join('\n');
}

function isMergeReadyState(mergeState: string): boolean {
  return mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS' || mergeState === 'UNSTABLE';
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

  const data = parsePrMergeStateView(output);

  // GitHub may not compute mergeStateStatus when branch protection is absent,
  // leaving it permanently UNKNOWN. Fall back to the mergeable field which is
  // computed independently.
  if (data.mergeStateStatus === 'UNKNOWN' && data.mergeable === 'MERGEABLE') {
    return 'CLEAN';
  }

  return data.mergeStateStatus;
}

async function getBlockedMergeState(pr: QueuedPR, nwo: string): Promise<BlockedMergeState> {
  let checks;
  try {
    checks = await fetchChecks(nwo, String(pr.number));
  } catch (err) {
    throw new Error(`Could not fetch CI checks for PR #${pr.number}: ${toErrorMessage(err)}`);
  }

  const { pending, failed } = classifyChecks(checks);

  if (failed.length > 0) {
    const names = failed.map((check) => check.name).join(', ');
    return {
      kind: 'failed',
      reason: `PR #${pr.number} is blocked by failed CI checks: ${names}.`,
    };
  }

  if (pending.length > 0) {
    const names = pending.map((check) => check.name).join(', ');
    return {
      kind: 'pending',
      reason: `PR #${pr.number} is blocked by pending CI checks: ${names}. Retry when they complete.`,
    };
  }

  return {
    kind: 'blocked',
    reason: `PR #${pr.number} is blocked, likely due to required reviews or branch protection requirements.`,
  };
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
    return (await getBlockedMergeState(pr, nwo)).reason;
  }

  if (mergeState === 'UNKNOWN') {
    return `GitHub has not computed merge state for PR #${pr.number} yet. Retry shortly.`;
  }

  return `Unrecognized merge state '${mergeState}' for PR #${pr.number}.`;
}

async function enforcePassingChecks(
  pr: QueuedPR,
  nwo: string,
  treatPendingChecksAsFailure: boolean,
  mergeLogger: Logger
): Promise<boolean> {
  let checks;
  try {
    checks = await fetchChecks(nwo, String(pr.number));
  } catch (err) {
    throw new Error(`Could not fetch CI checks for PR #${pr.number}: ${toErrorMessage(err)}`);
  }

  const { pending, failed } = classifyChecks(checks);

  if (failed.length > 0) {
    const names = failed.map((check) => check.name).join(', ');
    throw new Error(`PR #${pr.number} has failed CI checks: ${names}.`);
  }

  if (pending.length > 0) {
    const names = pending.map((check) => check.name).join(', ');
    const reason = `PR #${pr.number} has pending CI checks: ${names}. Retry when they complete.`;
    if (treatPendingChecksAsFailure) {
      throw new Error(reason);
    }

    mergeLogger.log(reason);
    return false;
  }

  return true;
}

async function remediateMergeFailure(
  pr: QueuedPR,
  issueNumber: number,
  nwo: string,
  reason: string,
  mergeLogger: Logger
): Promise<void> {
  const message = formatFailureComment(pr.number, reason);
  mergeLogger.error(`\n${message}`);

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
    mergeLogger.error(`Warning: Failed to update labels on PR #${pr.number}`);
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
    mergeLogger.error(`Warning: Failed to update labels on issue #${issueNumber}`);
  }

  try {
    await gh(['pr', 'comment', String(pr.number), '-R', nwo, '--body', message]);
  } catch {
    mergeLogger.error(`Warning: Failed to post failure comment on PR #${pr.number}`);
  }
}

export async function getLinkedIssueNumber(
  prNumber: number,
  nwo: string,
  mergeLogger: Logger = logger
): Promise<number | null> {
  let json = '';
  try {
    const { stdout } = await gh(['pr', 'view', String(prNumber), '-R', nwo, '--json', 'body']);
    json = stdout;
  } catch {
    mergeLogger.warn(`Failed to fetch linked issue for PR #${prNumber}`);
    return null;
  }

  const { body } = parsePrBodyView(json);
  const match = /(?:^|\s)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/im.exec(body);
  return match?.[1] ? Number(match[1]) : null;
}

export async function postMerge(
  _pr: QueuedPR,
  issueNumber: number,
  nwo: string,
  dryRun: boolean,
  mergeLogger: Logger = logger
): Promise<void> {
  if (dryRun) {
    mergeLogger.log(`  [dry-run] Would remove shipper:ready and close issue #${issueNumber}`);
    return;
  }

  const repoArgs = ['-R', nwo];
  try {
    await gh(['issue', 'edit', String(issueNumber), ...repoArgs, '--remove-label', READY_LABEL]);
  } catch (err) {
    mergeLogger.warn(
      `  Warning: Failed to remove shipper:ready label from issue #${issueNumber}: ${toErrorMessage(err)}`
    );
  }

  try {
    await gh(['issue', 'close', String(issueNumber), ...repoArgs]);
    mergeLogger.log(`  Issue #${issueNumber} closed.`);
  } catch (err) {
    mergeLogger.warn(`  Warning: Failed to close issue #${issueNumber}: ${toErrorMessage(err)}`);
  }
}

export async function isPrMerged(
  prNumber: number,
  nwo: string,
  mergeLogger: Logger = logger
): Promise<boolean | null> {
  let stdout = '';
  try {
    const result = await gh(['pr', 'view', String(prNumber), '-R', nwo, '--json', 'state']);
    stdout = result.stdout;
  } catch {
    mergeLogger.warn(`Failed to check merge status for PR #${prNumber}`);
    return null;
  }

  const { state } = parsePrStateView(stdout);
  return state === 'MERGED';
}

export async function pollPrMerged(
  prNumber: number,
  nwo: string,
  mergeLogger: Logger = logger
): Promise<boolean> {
  for (let attempt = 0; attempt < MERGE_POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleepMs(MERGE_POLL_BASE_DELAY_MS * 2 ** (attempt - 1));
    }

    if ((await isPrMerged(prNumber, nwo, mergeLogger)) === true) {
      return true;
    }
  }

  return false;
}

export async function executeMerge(options: ExecuteMergeOptions): Promise<boolean> {
  const {
    pr,
    issueNumber,
    nwo,
    logger: mergeLogger,
    logStream,
    treatPendingChecksAsFailure,
  } = options;

  return await withStageHooks(
    'merge',
    { issueNumber: String(issueNumber), branchName: pr.headRefName },
    async () => {
      const completePostMerge = async (message: string): Promise<boolean> => {
        mergeLogger.log(message);
        await postMerge(pr, issueNumber, nwo, false, mergeLogger);
        return true;
      };

      try {
        let mergeState = await getMergeStateStatus(pr.number, nwo);
        let rebased = false;

        if (mergeState === 'BEHIND') {
          mergeLogger.log(`PR #${pr.number} is behind its base branch. Rebasing before merge.`);
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
            throw new Error(`Failed to update branch: ${toErrorMessage(err)}`);
          }

          rebased = true;
          mergeState = await getMergeStateStatus(pr.number, nwo);
        }

        if (mergeState === 'UNKNOWN') {
          mergeLogger.log(`PR #${pr.number} merge state is UNKNOWN. Polling for resolution...`);
          for (let attempt = 0; attempt < UNKNOWN_STATE_POLL_MAX; attempt++) {
            await sleepMs(UNKNOWN_STATE_POLL_DELAY_MS);
            mergeState = await getMergeStateStatus(pr.number, nwo);
            if (mergeState !== 'UNKNOWN') {
              break;
            }
          }
        }

        if (mergeState === 'BLOCKED') {
          const blockedState = await getBlockedMergeState(pr, nwo);
          if (blockedState.kind === 'pending' && !treatPendingChecksAsFailure) {
            mergeLogger.log(blockedState.reason);
            return false;
          }

          throw new Error(blockedState.reason);
        }

        if (!isMergeReadyState(mergeState)) {
          throw new Error(await getMergeStateFailureReason(pr, nwo, mergeState, rebased));
        }

        if (getSettings().merge.requirePassingChecks) {
          const checksPassed = await enforcePassingChecks(
            pr,
            nwo,
            treatPendingChecksAsFailure,
            mergeLogger
          );
          if (!checksPassed) {
            return false;
          }
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
          return await completePostMerge(`PR #${pr.number} merged successfully.`);
        } catch (err) {
          const merged = await pollPrMerged(pr.number, nwo, mergeLogger);
          if (merged) {
            return await completePostMerge(
              `PR #${pr.number} merge succeeded despite reported error. Proceeding with post-merge cleanup.`
            );
          }

          throw new Error(`Merge failed: ${toErrorMessage(err)}`);
        }
      } catch (err) {
        const reason = toErrorMessage(err);
        await remediateMergeFailure(pr, issueNumber, nwo, reason, mergeLogger);
        throw new Error(`Merge failed for PR #${pr.number}: ${reason}`);
      }
    }
  );
}
