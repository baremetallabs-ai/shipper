import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  aggregateSessionUsage,
  classifyChecks,
  clearStaleLockIfNeeded,
  createLogger,
  fetchChecks,
  fetchIssueTimelines,
  handleAgentCrash,
  logger,
  selectIssuesForStage,
  sleepMs,
  sortIssuesByLabelTime,
  gh,
  getSettings,
  processResult,
  resolveMode,
  retryOnInvalidOutput,
  scrubOutputDir,
  toError,
  toErrorMessage,
  totalTokens as getTotalTokens,
  withStageHooks,
  releaseIssueLock,
  withIssueLock,
  runPrompt,
  STAGE_NAME_MAP,
  STAGE_LABEL_NAMES,
  NEW_LABEL,
  PR_REVIEWED_LABEL,
  PRIORITY_LABEL_NAMES,
  READY_LABEL,
  BLOCKED_LABEL,
  LOCKED_LABEL,
  FAILED_LABEL,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode, Logger } from '@dnsquared/shipper-core';
import { pollPrMerged, postMerge } from './merge.js';
import type { QueuedPR } from './merge.js';
import { buildReadyCheck, SKIP_PR_REMEDIATE_WAIT_ENV_VAR } from './pr-remediate.js';
import { prepareUnblockContext } from './unblock.js';

const MAX_TRANSITIONS = 15;
const MERGE_FAILURE_PREFIX = 'Merge failed for PR #';
const PARKED_POLL_INTERVAL_MS = 20_000;
const AUTO_CHILD_RUN_ENV_VAR = 'SHIPPER_AUTO_CHILD_RUN';
const tokenFormatter = new Intl.NumberFormat('en-US');

export const STAGE_NAME: Record<string, string> = { ...STAGE_NAME_MAP };

export const AUTO_PRIORITY_LABELS: string[] = [...STAGE_LABEL_NAMES].reverse();

const STAGE_MODE_KEY: Record<string, string> = {
  'pr open': 'pr_open',
  'pr review': 'pr_review',
  'pr remediate': 'pr_remediate',
};

interface StageResult {
  stage: string;
  status: 'pass' | 'fail';
}

export interface AutoResult {
  issue: number;
  title: string;
  outcome: 'pass' | 'fail';
  error?: string;
  totalTokens?: number;
}

export interface UnblockAttempt {
  issue: number;
  title: string;
  outcome: 'unblocked' | 'still blocked';
  logFile?: string;
}

export interface ShipOptions {
  merge: boolean;
  auto: boolean;
  parallel?: number;
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
}

interface ShipIssueResult {
  success: boolean;
  error?: string;
  retriable?: boolean;
  totalTokens?: number;
}

interface AsyncIssueRun {
  child: ChildProcess;
  result: Promise<ShipIssueResult>;
}

interface ActiveIssueRun {
  issue: { number: number; title: string };
  child: ChildProcess;
  completion: Promise<{
    issue: { number: number; title: string };
    result: ShipIssueResult;
  }>;
}

type ShipSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';
type ReadyCheck = () => Promise<boolean>;

interface ParkRequest {
  readyCheck: ReadyCheck;
  resume: () => void;
}

interface ParkHooks {
  shouldPark: () => Promise<boolean>;
  park: (request: ParkRequest) => void;
}

interface ParkObserver {
  hooks: ParkHooks;
  waitForNextPark: () => Promise<ParkRequest | null>;
  close: () => void;
}

interface SequentialIssueRun {
  issue: { number: number; title: string };
  completion: Promise<ShipIssueResult>;
  waitForNextPark: () => Promise<ParkRequest | null>;
}

interface ParkedIssue {
  issue: { number: number; title: string };
  readyCheck: ReadyCheck;
  resume: () => void;
  run: SequentialIssueRun;
}

interface PRMergeStateViewData {
  mergeStateStatus: string;
  mergeable: string;
}

function getStageModeKey(stageName: string): string {
  return STAGE_MODE_KEY[stageName] ?? stageName;
}

function buildIssueCommandEnv(
  issueStr: string,
  skipPrRemediateWaitOnce: boolean
): typeof process.env {
  return {
    ...process.env,
    SHIPPER_LOCK_HELD: issueStr,
    ...(skipPrRemediateWaitOnce ? { [SKIP_PR_REMEDIATE_WAIT_ENV_VAR]: '1' } : {}),
  };
}

function formatLogTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function formatLogDisplayPath(logFile: string, homeDir = homedir()): string {
  return logFile.startsWith(homeDir) ? `~${logFile.slice(homeDir.length)}` : logFile;
}

function summarizeChildStderr(stderrOutput: string): string {
  const nonLifecycleLines = stderrOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('[shipper] '));

  if (nonLifecycleLines.length > 0) {
    return nonLifecycleLines.join('\n');
  }

  return stderrOutput.trim();
}

function writeStdoutBoth(logStream: WriteStream | undefined, chunk: string | Buffer): void {
  process.stdout.write(chunk);
  logStream?.write(chunk);
}

function writeStderrBoth(logStream: WriteStream | undefined, chunk: string | Buffer): void {
  process.stderr.write(chunk);
  logStream?.write(chunk);
}

function closeLogStream(logStream: WriteStream | undefined): Promise<void> {
  if (!logStream || logStream.destroyed || logStream.writableEnded) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const resolveClose = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const rejectClose = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(toError(err));
    };

    logStream.on('finish', resolveClose);
    logStream.on('close', resolveClose);
    logStream.on('error', rejectClose);
    logStream.end();
  });
}

function spawnTee(
  command: string,
  args: string[],
  opts: { env?: typeof process.env; logStream?: WriteStream; interactive?: boolean }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const stdio: StdioOptions = opts.logStream
      ? opts.interactive
        ? 'inherit'
        : ['inherit', 'pipe', 'pipe']
      : 'inherit';
    const child = spawn(command, args, {
      stdio,
      env: opts.env,
    });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      writeStdoutBoth(opts.logStream, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      writeStderrBoth(opts.logStream, chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function getCurrentLabel(repo: string, issueStr: string): Promise<string | undefined> {
  let output: string;
  try {
    const result = await gh([
      'issue',
      'view',
      issueStr,
      '-R',
      repo,
      '--json',
      'labels',
      '--jq',
      '.labels[].name',
    ]);
    output = result.stdout.trim();
  } catch {
    logger.warn(`Failed to fetch labels for issue #${issueStr}`);
    return undefined;
  }

  if (!output) return undefined;

  const shipperLabels = output
    .split(/\r?\n/)
    .filter(
      (name) =>
        name.startsWith('shipper:') &&
        name !== BLOCKED_LABEL &&
        name !== LOCKED_LABEL &&
        !PRIORITY_LABEL_NAMES.includes(name)
    );

  if (shipperLabels.includes(FAILED_LABEL)) {
    return FAILED_LABEL;
  }

  const stageLabels = shipperLabels.filter((name) => name !== FAILED_LABEL);

  if (stageLabels.length !== 1) return undefined;

  return stageLabels[0];
}

function printSummary(results: StageResult[], issueLogger: Logger): void {
  issueLogger.log('\nStage summary:');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : '✗';
    const suffix = r.status === 'fail' ? ' — failed' : '';
    issueLogger.log(`  ${icon} ${r.stage}${suffix}`);
  }
}

export function printAutoSummary(results: AutoResult[]): void {
  if (results.length === 0) {
    logger.log('\nAuto run complete. No eligible issues found.');
    return;
  }

  const tokenWidth = Math.max(
    'Tokens'.length,
    ...results.map((result) =>
      result.totalTokens === undefined ? 1 : tokenFormatter.format(result.totalTokens).length
    )
  );

  logger.log('\nAuto run complete.\n');
  logger.log(
    `  #    Issue                                          ${'Tokens'.padStart(tokenWidth)}  Outcome`
  );
  for (const r of results) {
    const num = String(r.issue).padEnd(5);
    const titleChars = Array.from(r.title);
    const title =
      titleChars.length > 45 ? titleChars.slice(0, 42).join('') + '...' : r.title.padEnd(45);
    const tokens =
      r.totalTokens === undefined
        ? '—'.padStart(tokenWidth)
        : tokenFormatter.format(r.totalTokens).padStart(tokenWidth);
    const outcome = r.outcome === 'pass' ? '✓ pass' : `✗ fail — ${r.error ?? 'unknown error'}`;
    logger.log(`  ${num}${title} ${tokens}  ${outcome}`);
  }
}

async function resolvePrForIssue(issueNumber: number, nwo: string): Promise<QueuedPR> {
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

const UNKNOWN_STATE_POLL_MAX = 5;
const UNKNOWN_STATE_POLL_DELAY_MS = 3_000;

function formatMergeFailureMessage(prNumber: number, reason: string): string {
  const prefix = `${MERGE_FAILURE_PREFIX}${prNumber}:`;
  return reason.startsWith(prefix) ? reason : `${prefix} ${reason}`;
}

function isMergeReadyState(mergeState: string): boolean {
  return mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS' || mergeState === 'UNSTABLE';
}

function isRetriableMergeFailure(error?: string): boolean {
  return error?.includes(MERGE_FAILURE_PREFIX) ?? false;
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

async function mergePr(
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

async function shipOneIssue(
  repo: string,
  issue: string,
  merge: boolean,
  mode?: CommandMode,
  agent?: AgentName,
  model?: string,
  parkHooks?: ParkHooks,
  logFile?: string
): Promise<ShipIssueResult> {
  const issueStr = issue.replace(/^#/, '');
  const issueStartTime = new Date();
  const isAutoChildRun = process.env[AUTO_CHILD_RUN_ENV_VAR] === '1';
  const logStream = logFile ? createWriteStream(logFile) : undefined;
  const issueLogger = createLogger({ stream: logStream });
  let logStreamError: string | undefined;

  if (logStream && logFile) {
    logStream.on('error', (error) => {
      if (logStreamError) {
        return;
      }
      logStreamError = `failed to write log file "${logFile}": ${error.message}`;
    });
  }

  try {
    const result = await withIssueLock(repo, issueStr, async () => {
      let label = await getCurrentLabel(repo, issueStr);

      if (label === FAILED_LABEL) {
        const msg = `Issue #${issueStr} is marked ${FAILED_LABEL} and requires manual intervention before it can re-enter the pipeline.`;
        issueLogger.error(msg);
        return { success: false, error: msg };
      }

      if (!label) {
        const msg = `Issue #${issueStr} has no shipper label. Run \`shipper next\` or add a label first.`;
        issueLogger.error(msg);
        return { success: false, error: msg };
      }

      if (label === READY_LABEL) {
        if (!merge) {
          issueLogger.log(`Issue #${issueStr} is already at ${READY_LABEL}.`);
          return { success: true };
        }
        // Fall through to merge logic below the loop
      }

      if (label !== READY_LABEL && !(label in STAGE_NAME)) {
        const msg = `Unrecognized shipper label "${label}" on issue #${issueStr}.`;
        issueLogger.error(msg);
        return { success: false, error: msg };
      }

      const results: StageResult[] = [];
      const transitionHistory: string[] = [label];
      const failCurrentStage = (stage: string, message: string): ShipIssueResult => {
        issueLogger.error(message);
        results.push({ stage, status: 'fail' });
        printSummary(results, issueLogger);
        return { success: false, error: message };
      };

      if (label !== READY_LABEL) {
        let transitions = 0;
        let skipPrRemediateWaitOnce = false;
        const cliEntrypoint = process.argv[1];
        if (!cliEntrypoint) {
          throw new Error('Missing CLI entrypoint path.');
        }

        for (;;) {
          const stageName = STAGE_NAME[label];
          if (!stageName) {
            const msg = `Unrecognized shipper label "${label}" on issue #${issueStr}.`;
            issueLogger.error(msg);
            printSummary(results, issueLogger);
            return { success: false, error: msg };
          }
          const previousLabel: string | undefined = label;

          if (label === PR_REVIEWED_LABEL && parkHooks) {
            let pr: QueuedPR;
            try {
              pr = await resolvePrForIssue(Number(issueStr), repo);
            } catch (err) {
              return failCurrentStage(stageName, toErrorMessage(err));
            }

            let readyCheck: ReadyCheck;
            try {
              readyCheck = await buildReadyCheck(
                repo,
                String(pr.number),
                getSettings().prReviewWait
              );
            } catch (err) {
              return failCurrentStage(stageName, toErrorMessage(err));
            }

            const readyNow = await readyCheck();
            if (!readyNow && (await parkHooks.shouldPark())) {
              const resumePromise = new Promise<void>((resolve) => {
                parkHooks.park({ readyCheck, resume: resolve });
              });
              await resumePromise;
              skipPrRemediateWaitOnce = true;
            }
          }

          const stageMode = resolveMode(getStageModeKey(stageName), mode);
          if (isAutoChildRun && stageMode === 'interactive') {
            issueLogger.log(
              `Skipping issue #${issueStr}: stage "${stageName}" requires interactive mode.`
            );
            return { success: true };
          }

          issueLogger.log(`Running stage: ${stageName}`);

          const nextArgs = [cliEntrypoint, 'next', issueStr];
          if (stageMode !== 'default') {
            nextArgs.push('--mode', stageMode);
          }
          if (agent) {
            nextArgs.push('--agent', agent);
          }
          if (model) {
            nextArgs.push('--model', model);
          }
          const status = await spawnTee(process.execPath, nextArgs, {
            env: buildIssueCommandEnv(
              issueStr,
              label === PR_REVIEWED_LABEL && skipPrRemediateWaitOnce
            ),
            logStream,
            interactive: stageMode === 'interactive',
          });
          skipPrRemediateWaitOnce = false;

          if (logStreamError) {
            return failCurrentStage(stageName, logStreamError);
          }

          if (status !== 0) {
            results.push({ stage: stageName, status: 'fail' });
            printSummary(results, issueLogger);
            return { success: false, error: `stage "${stageName}" failed` };
          }

          results.push({ stage: stageName, status: 'pass' });

          label = await getCurrentLabel(repo, issueStr);

          if (!label || (label !== READY_LABEL && !(label in STAGE_NAME))) {
            if (!label) {
              issueLogger.error(
                `Issue #${issueStr} has no shipper label after stage "${stageName}".`
              );
            } else if (label === FAILED_LABEL) {
              issueLogger.error(
                `Issue #${issueStr} entered terminal state ${FAILED_LABEL} after stage "${stageName}".`
              );
            } else {
              issueLogger.error(
                `Unrecognized shipper label "${label}" on issue #${issueStr} after stage "${stageName}".`
              );
            }
            printSummary(results, issueLogger);
            return { success: false, error: `unexpected label after stage "${stageName}"` };
          }

          if (label === NEW_LABEL && previousLabel !== NEW_LABEL) {
            const msg = `Issue #${issueStr} was reset to ${NEW_LABEL} by stage "${stageName}" — stopping because the stage rejected backward.`;
            issueLogger.error(msg);
            results[results.length - 1] = { stage: stageName, status: 'fail' };
            printSummary(results, issueLogger);
            return { success: false, error: msg };
          }

          if (label === previousLabel) {
            const msg = `Label did not advance after stage "${stageName}" (still "${label}"). Aborting to avoid infinite loop.`;
            issueLogger.error(msg);
            printSummary(results, issueLogger);
            return { success: false, error: msg };
          }

          transitions++;
          transitionHistory.push(label);

          if (transitions >= MAX_TRANSITIONS) {
            const history = transitionHistory.join(' → ');
            const msg = `Issue #${issueStr} hit transition cap (${MAX_TRANSITIONS}): ${history}`;
            issueLogger.error(msg);

            try {
              await gh([
                'issue',
                'edit',
                issueStr,
                '-R',
                repo,
                '--add-label',
                FAILED_LABEL,
                '--remove-label',
                label,
              ]);
            } catch (err) {
              issueLogger.error(
                `Warning: Failed to update labels on issue #${issueStr}: ${toErrorMessage(err)}`
              );
            }

            results.push({ stage: STAGE_NAME[label] ?? label, status: 'fail' });
            printSummary(results, issueLogger);
            return { success: false, error: msg };
          }

          if (label === READY_LABEL) {
            break;
          }
        }
      }

      if (merge) {
        issueLogger.log('Running stage: merge');
        const issueNumber = Number(issueStr);
        const nwo = repo;

        let pr: QueuedPR;
        try {
          pr = await resolvePrForIssue(issueNumber, nwo);
        } catch (err) {
          const msg = toErrorMessage(err);
          issueLogger.error(msg);
          results.push({ stage: 'merge', status: 'fail' });
          printSummary(results, issueLogger);
          return { success: false, error: msg };
        }

        try {
          await withStageHooks(
            'merge',
            { issueNumber: issueStr, branchName: pr.headRefName },
            async () => {
              await mergePr(pr, issueNumber, nwo, issueLogger, logStream);
            }
          );
          results.push({ stage: 'merge', status: 'pass' });
        } catch (err) {
          const msg = toErrorMessage(err);
          results.push({ stage: 'merge', status: 'fail' });
          printSummary(results, issueLogger);
          return { success: false, error: msg, retriable: isRetriableMergeFailure(msg) };
        }
      }

      printSummary(results, issueLogger);
      return { success: true };
    });
    if (isAutoChildRun) {
      return result;
    }
    return await attachIssueTotalTokens(repo, issueStr, issueStartTime, result);
  } finally {
    try {
      await closeLogStream(logStream);
    } catch {
      // Log stream close failures should not replace the ship result.
    }
  }
}

function shipOneIssueAsync(
  issue: string,
  logFile?: string,
  agent?: AgentName,
  model?: string
): AsyncIssueRun {
  const cliEntrypoint = process.argv[1];
  if (!cliEntrypoint) {
    throw new Error('Missing CLI entrypoint path.');
  }

  const stderr: string[] = [];
  const logStream = logFile ? createWriteStream(logFile) : undefined;
  let logStreamError: string | undefined;
  const shipArgs = [cliEntrypoint, 'ship', issue, '--merge'];
  if (agent) {
    shipArgs.push('--agent', agent);
  }
  if (model) {
    shipArgs.push('--model', model);
  }
  const child = spawn(process.execPath, shipArgs, {
    stdio: logFile ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      [AUTO_CHILD_RUN_ENV_VAR]: '1',
    },
  });

  if (logStream) {
    logStream.on('error', (error) => {
      if (logStreamError) return;
      logStreamError = `failed to write log file "${logFile}": ${error.message}`;
      child.stdout?.unpipe(logStream);
      child.stderr?.unpipe(logStream);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    });
    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(chunk.toString());
    });
  }

  const result = new Promise<ShipIssueResult>((resolve) => {
    let settled = false;
    let logStreamClosed = false;

    const resolveResult = (value: ShipIssueResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const closeLogStream = (destroy = false): Promise<void> => {
      if (!logStream || logStreamClosed || logStream.destroyed || logStreamError) {
        return Promise.resolve();
      }
      logStreamClosed = true;

      return new Promise<void>((streamResolved) => {
        let streamSettled = false;
        const finish = () => {
          if (streamSettled) return;
          streamSettled = true;
          streamResolved();
        };

        logStream.once('finish', finish);
        logStream.once('close', finish);
        logStream.once('error', finish);

        if (destroy) {
          logStream.destroy();
          return;
        }

        logStream.end();
      });
    };

    child.on('error', (error) => {
      void closeLogStream(true).finally(() => {
        resolveResult({ success: false, error: error.message });
      });
    });

    child.on('close', (code, signal) => {
      void closeLogStream().finally(() => {
        if (code === 0) {
          if (logStreamError) {
            resolveResult({ success: false, error: logStreamError });
            return;
          }
          resolveResult({ success: true });
          return;
        }

        if (logStreamError) {
          resolveResult({ success: false, error: logStreamError });
          return;
        }

        const stderrOutput = stderr.join('').trim();
        if (stderrOutput) {
          resolveResult({ success: false, error: summarizeChildStderr(stderrOutput) });
          return;
        }

        if (signal) {
          resolveResult({ success: false, error: `child exited from signal ${signal}` });
          return;
        }

        resolveResult({ success: false, error: `child exited with code ${code ?? 'unknown'}` });
      });
    });
  });

  return { child, result };
}

export async function selectNextCandidate(
  repo: string,
  skippedIssues: Set<number>,
  activeIssues: ReadonlySet<number> = new Set<number>()
): Promise<{ number: number; title: string } | null> {
  const stageData: Array<{
    label: string;
    stageIndex: number;
    staleLocked: Set<number>;
    candidates: Array<{ number: number; title: string; priority: 0 | 1 | 2 }>;
  }> = [];

  for (let stageIndex = 0; stageIndex < AUTO_PRIORITY_LABELS.length; stageIndex++) {
    const label = AUTO_PRIORITY_LABELS[stageIndex];
    if (!label) {
      continue;
    }
    const staleLocked = new Set<number>();
    const issues = await selectIssuesForStage(repo, label, staleLocked, { skipTimeline: true });
    const candidates = issues.filter(
      (issue) => !skippedIssues.has(issue.number) && !activeIssues.has(issue.number)
    );

    stageData.push({ label, stageIndex, staleLocked, candidates });
  }

  let winningStage:
    | {
        label: string;
        stageIndex: number;
        staleLocked: Set<number>;
        candidates: Array<{ number: number; title: string; priority: 0 | 1 | 2 }>;
      }
    | undefined;
  let winningPriority: 0 | 1 | 2 | undefined;

  for (const stage of stageData) {
    const stageCandidate = stage.candidates[0];
    if (!stageCandidate) {
      continue;
    }

    if (
      !winningStage ||
      winningPriority === undefined ||
      stageCandidate.priority < winningPriority ||
      (stageCandidate.priority === winningPriority && stage.stageIndex < winningStage.stageIndex)
    ) {
      winningStage = stage;
      winningPriority = stageCandidate.priority;
    }
  }

  if (!winningStage || winningPriority === undefined) {
    return null;
  }

  const bucketCandidates = winningStage.candidates.filter(
    (candidate) => candidate.priority === winningPriority
  );
  const bucketWinner = bucketCandidates[0];
  if (!bucketWinner) {
    return null;
  }

  let winner = bucketWinner;
  if (bucketCandidates.length >= 2) {
    const timelinesByIssue = await fetchIssueTimelines(
      repo,
      bucketCandidates.map((candidate) => candidate.number)
    );
    const sortedCandidates = sortIssuesByLabelTime(
      bucketCandidates,
      timelinesByIssue,
      winningStage.label
    );
    winner = sortedCandidates[0] ?? bucketWinner;
  }

  await clearStaleLockIfNeeded(repo, winner.number, winningStage.staleLocked);

  return { number: winner.number, title: winner.title };
}

export async function selectBlockedIssues(
  repo: string
): Promise<{ number: number; title: string }[]> {
  let output: string;
  try {
    const result = await gh([
      'issue',
      'list',
      '-R',
      repo,
      '--label',
      BLOCKED_LABEL,
      '--state',
      'open',
      '--search',
      `-label:${LOCKED_LABEL}`,
      '--json',
      'number,title,labels',
      '--limit',
      '1000',
    ]);
    output = result.stdout.trim();
  } catch {
    logger.warn('Failed to fetch blocked issues');
    return [];
  }

  if (!output) return [];

  let issues: { number: number; title: string; labels: { name: string }[] }[];
  try {
    issues = JSON.parse(output) as { number: number; title: string; labels: { name: string }[] }[];
  } catch {
    logger.warn('Failed to parse blocked issues response');
    return [];
  }

  // Sort by stage priority — issues with higher-priority stage labels come first
  issues.sort((a, b) => {
    const aLabels = new Set(a.labels.map((l) => l.name));
    const bLabels = new Set(b.labels.map((l) => l.name));
    let aIdx = AUTO_PRIORITY_LABELS.length;
    let bIdx = AUTO_PRIORITY_LABELS.length;
    for (let i = 0; i < AUTO_PRIORITY_LABELS.length; i++) {
      const label = AUTO_PRIORITY_LABELS[i];
      if (!label) continue;
      if (aLabels.has(label) && aIdx === AUTO_PRIORITY_LABELS.length) aIdx = i;
      if (bLabels.has(label) && bIdx === AUTO_PRIORITY_LABELS.length) bIdx = i;
    }
    return aIdx - bIdx;
  });

  return issues.map((i) => ({ number: i.number, title: i.title }));
}

async function attemptUnblock(
  repo: string,
  issueStr: string,
  agent?: AgentName,
  model?: string,
  logFile?: string
): Promise<boolean> {
  const cwd = process.cwd();

  return await withIssueLock(repo, issueStr, async () => {
    await scrubOutputDir(cwd);
    await prepareUnblockContext(repo, issueStr, cwd);
    const exitCode = await runPrompt('unblock', {
      repo,
      issueRef: issueStr,
      agent,
      model,
      logFile,
    });
    if (exitCode !== 0) {
      const detail = `Agent exited with code ${exitCode}`;
      logger.error(detail);
      await handleAgentCrash(
        repo,
        issueStr,
        'unblock',
        detail,
        `The \`unblock\` agent run exited with code ${exitCode}.`
      );
      return false;
    }
    try {
      const validatedResult = await retryOnInvalidOutput({
        cwd,
        stage: 'unblock',
        retry: (userInput) =>
          runPrompt('unblock', { repo, issueRef: issueStr, agent, model, logFile, userInput }),
      });
      const result = await processResult({
        repo,
        issueNumber: issueStr,
        stage: 'unblock',
        cwd,
        result: validatedResult,
      });
      return result.verdict === 'accept';
    } catch (error) {
      const detail = toErrorMessage(error);
      logger.error(detail);
      await handleAgentCrash(repo, issueStr, 'unblock', detail);
      return false;
    }
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createParkObserver(shouldPark: () => Promise<boolean>): ParkObserver {
  const queued: ParkRequest[] = [];
  const waiters: Array<(request: ParkRequest | null) => void> = [];
  let closed = false;

  return {
    hooks: {
      shouldPark,
      park: (request) => {
        if (closed) {
          return;
        }
        const waiter = waiters.shift();
        if (waiter) {
          waiter(request);
          return;
        }
        queued.push(request);
      },
    },
    waitForNextPark: async () => {
      const queuedRequest = queued.shift();
      if (queuedRequest) {
        return queuedRequest;
      }
      if (closed) {
        return null;
      }
      return await new Promise<ParkRequest | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.(null);
      }
    },
  };
}

function startSequentialIssueRun(
  repo: string,
  issue: { number: number; title: string },
  shouldPark: () => Promise<boolean>,
  logFile?: string,
  agent?: AgentName,
  model?: string
): SequentialIssueRun {
  const parkObserver = createParkObserver(shouldPark);
  const completion = shipOneIssue(
    repo,
    String(issue.number),
    true,
    undefined,
    agent,
    model,
    parkObserver.hooks,
    logFile
  ).finally(() => {
    parkObserver.close();
  });

  return {
    issue,
    completion,
    waitForNextPark: parkObserver.waitForNextPark,
  };
}

async function waitForCompletionOrPark(
  run: SequentialIssueRun
): Promise<
  { type: 'completed'; result: ShipIssueResult } | { type: 'parked'; parked: ParkedIssue }
> {
  const parkRequest = await run.waitForNextPark();
  if (parkRequest) {
    return {
      type: 'parked',
      parked: {
        issue: run.issue,
        readyCheck: parkRequest.readyCheck,
        resume: parkRequest.resume,
        run,
      },
    };
  }

  return {
    type: 'completed',
    result: await run.completion,
  };
}

async function pollReadyParked(parked: readonly ParkedIssue[]): Promise<ParkedIssue | null> {
  for (const parkedIssue of parked) {
    if (await parkedIssue.readyCheck()) {
      return parkedIssue;
    }
  }
  return null;
}

async function waitForReadyParked(parked: readonly ParkedIssue[]): Promise<ParkedIssue> {
  for (;;) {
    const ready = await pollReadyParked(parked);
    if (ready) {
      return ready;
    }
    await wait(PARKED_POLL_INTERVAL_MS);
  }
}

function recordAutoResult(
  results: AutoResult[],
  skippedIssues: Set<number>,
  issue: { number: number; title: string },
  result: ShipIssueResult
): void {
  if (result.success) {
    skippedIssues.add(issue.number);
    results.push({
      issue: issue.number,
      title: issue.title,
      outcome: 'pass',
      totalTokens: result.totalTokens,
    });
    return;
  }

  if (result.retriable !== true) {
    skippedIssues.add(issue.number);
  }
  results.push({
    issue: issue.number,
    title: issue.title,
    outcome: 'fail',
    error: result.error,
    totalTokens: result.totalTokens,
  });
}

async function resumeParkedIssue(
  parked: ParkedIssue[],
  readyParked: ParkedIssue,
  results: AutoResult[],
  skippedIssues: Set<number>
): Promise<void> {
  const parkedIndex = parked.indexOf(readyParked);
  if (parkedIndex !== -1) {
    parked.splice(parkedIndex, 1);
  }

  readyParked.resume();
  const resumedOutcome = await waitForCompletionOrPark(readyParked.run);
  if (resumedOutcome.type === 'parked') {
    parked.push(resumedOutcome.parked);
    return;
  }

  recordAutoResult(results, skippedIssues, readyParked.issue, resumedOutcome.result);
}

export function printUnblockSummary(attempts: UnblockAttempt[], homeDir = homedir()): void {
  logger.log('\n  Unblock attempts:\n');
  logger.log('  Ref              Issue                                          Outcome');
  const finalByIssue = new Map<number, UnblockAttempt>();
  for (const a of attempts) {
    finalByIssue.delete(a.issue);
    finalByIssue.set(a.issue, a);
  }

  for (const a of finalByIssue.values()) {
    const ref = `unblock #${a.issue}`;
    const num = ref.padEnd(17);
    const titleChars = Array.from(a.title);
    const title =
      titleChars.length > 45 ? titleChars.slice(0, 42).join('') + '...' : a.title.padEnd(45);
    const outcome = a.outcome === 'unblocked' ? '✓ unblocked' : '— still blocked';
    logger.log(`  ${num}${title} ${outcome}`);
  }

  const withLogFiles = attempts.filter(
    (a): a is UnblockAttempt & { logFile: string } => !!a.logFile
  );
  if (withLogFiles.length > 0) {
    logger.log('\n  Unblock log files:');
    for (const a of withLogFiles) {
      logger.log(`  unblock #${a.issue}   ${formatLogDisplayPath(a.logFile, homeDir)}`);
    }
  }
}

async function shipAutoSequential(repo: string, agent?: AgentName, model?: string): Promise<void> {
  const skippedIssues = new Set<number>();
  const results: AutoResult[] = [];
  const allUnblockAttempts: UnblockAttempt[] = [];
  const parked: ParkedIssue[] = [];
  const homeDir = homedir();
  const logsDir = path.join(homeDir, '.shipper', 'logs');
  const logFiles = new Map<number, string>();

  mkdirSync(logsDir, { recursive: true, mode: 0o700 });

  const shouldParkCurrentIssue = async (): Promise<boolean> => {
    if (parked.length > 0) {
      return true;
    }
    return (await selectNextCandidate(repo, skippedIssues)) !== null;
  };

  for (;;) {
    // Inner loop: process all available candidates
    for (;;) {
      const readyParked = await pollReadyParked(parked);
      if (readyParked) {
        await resumeParkedIssue(parked, readyParked, results, skippedIssues);
        continue;
      }

      const candidate = await selectNextCandidate(repo, skippedIssues);
      if (!candidate) {
        break;
      }

      logger.log(`\nAuto: advancing issue #${candidate.number} — ${candidate.title}`);
      const logFile = path.join(logsDir, `ship-${candidate.number}-${formatLogTimestamp()}.log`);
      logFiles.set(candidate.number, logFile);
      const run = startSequentialIssueRun(
        repo,
        candidate,
        shouldParkCurrentIssue,
        logFile,
        agent,
        model
      );
      const outcome = await waitForCompletionOrPark(run);
      if (outcome.type === 'parked') {
        parked.push(outcome.parked);
      } else {
        recordAutoResult(results, skippedIssues, candidate, outcome.result);
      }
    }

    // Unblock pass
    const blocked = await selectBlockedIssues(repo);
    if (blocked.length === 0) {
      if (parked.length === 0) {
        break;
      }

      const readyParked = await waitForReadyParked(parked);
      await resumeParkedIssue(parked, readyParked, results, skippedIssues);
      continue;
    }

    let progress = false;
    for (const issue of blocked) {
      logger.log(`\nAuto: attempting unblock of #${issue.number} — ${issue.title}`);
      const unblockLogFile = path.join(
        logsDir,
        `unblock-${issue.number}-${formatLogTimestamp()}.log`
      );
      const unblocked = await attemptUnblock(
        repo,
        String(issue.number),
        agent,
        model,
        unblockLogFile
      );
      allUnblockAttempts.push({
        issue: issue.number,
        title: issue.title,
        outcome: unblocked ? 'unblocked' : 'still blocked',
        logFile: unblockLogFile,
      });
      if (unblocked) progress = true;
    }

    if (!progress) {
      if (parked.length === 0) {
        break;
      }

      const readyParked = await waitForReadyParked(parked);
      await resumeParkedIssue(parked, readyParked, results, skippedIssues);
      continue;
    }
    // Loop back — newly unblocked issues are now eligible candidates
  }

  printAutoSummary(results);
  if (allUnblockAttempts.length > 0) {
    printUnblockSummary(allUnblockAttempts, homeDir);
  }
  if (results.length > 0) {
    logger.log('\n  Log files:');
    for (const result of results) {
      const logFile = logFiles.get(result.issue);
      if (!logFile) continue;
      logger.log(`  #${result.issue}   ${formatLogDisplayPath(logFile, homeDir)}`);
    }
  }
  if (results.some((result) => result.outcome === 'fail')) {
    process.exitCode = 1;
  }
  return;
}

async function shipAutoParallel(
  repo: string,
  parallel: number,
  agent?: AgentName,
  model?: string
): Promise<void> {
  const skippedIssues = new Set<number>();
  const results: AutoResult[] = [];
  const allUnblockAttempts: UnblockAttempt[] = [];
  const activeRuns = new Map<number, ActiveIssueRun>();
  const issueStartTimes = new Map<number, Date>();
  const homeDir = homedir();
  const logsDir = path.join(homeDir, '.shipper', 'logs');
  const logFiles = new Map<number, string>();

  let shuttingDown = false;
  const isShuttingDown = (): boolean => shuttingDown;

  mkdirSync(logsDir, { recursive: true, mode: 0o700 });

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const onSignal = (signal: ShipSignal) => {
    if (isShuttingDown()) return;
    shuttingDown = true;

    void (async () => {
      for (const run of activeRuns.values()) {
        run.child.kill(signal);
      }

      await wait(3000);

      for (const [, run] of activeRuns) {
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill('SIGKILL');
        }
      }

      await Promise.allSettled(
        Array.from(activeRuns, ([issueNumber, run]) => {
          if (run.child.exitCode !== null || run.child.signalCode !== null) {
            return Promise.resolve();
          }
          return releaseIssueLock(repo, String(issueNumber));
        })
      );

      // Intentional: signal handlers cannot propagate through normal async control flow
      // after child shutdown and lock cleanup.
      process.exit(1);
    })();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (;;) {
      if (isShuttingDown()) break;

      while (!isShuttingDown() && activeRuns.size < parallel) {
        const candidate = await selectNextCandidate(
          repo,
          skippedIssues,
          new Set(activeRuns.keys())
        );
        if (!candidate) break;

        const logFile = path.join(logsDir, `ship-${candidate.number}-${formatLogTimestamp()}.log`);
        logger.log(
          `\n[#${candidate.number}] Auto: advancing issue #${candidate.number} — ${candidate.title}`
        );
        const run = shipOneIssueAsync(String(candidate.number), logFile, agent, model);
        issueStartTimes.set(candidate.number, new Date());
        logFiles.set(candidate.number, logFile);
        activeRuns.set(candidate.number, {
          issue: candidate,
          child: run.child,
          completion: run.result.then((result) => ({ issue: candidate, result })),
        });
      }

      if (isShuttingDown()) break;

      if (activeRuns.size === 0) {
        const blocked = await selectBlockedIssues(repo);
        if (blocked.length === 0) break;

        let progress = false;
        for (const issue of blocked) {
          logger.log(
            `\n[#${issue.number}] Auto: attempting unblock of #${issue.number} — ${issue.title}`
          );
          const unblockLogFile = path.join(
            logsDir,
            `unblock-${issue.number}-${formatLogTimestamp()}.log`
          );
          const unblocked = await attemptUnblock(
            repo,
            String(issue.number),
            agent,
            model,
            unblockLogFile
          );
          allUnblockAttempts.push({
            issue: issue.number,
            title: issue.title,
            outcome: unblocked ? 'unblocked' : 'still blocked',
            logFile: unblockLogFile,
          });
          if (unblocked) progress = true;
        }

        if (!progress) break;
        continue;
      }

      const completed = await Promise.race(
        Array.from(activeRuns.values(), (run) => run.completion)
      );
      activeRuns.delete(completed.issue.number);
      const issueStartTime = issueStartTimes.get(completed.issue.number);
      issueStartTimes.delete(completed.issue.number);
      const totalTokens =
        issueStartTime === undefined
          ? undefined
          : await resolveIssueTotalTokens(repo, String(completed.issue.number), issueStartTime);
      logger.log(`[#${completed.issue.number}] ${completed.result.success ? '✓ pass' : '✗ fail'}`);

      if (completed.result.success) {
        skippedIssues.add(completed.issue.number);
        results.push({
          issue: completed.issue.number,
          title: completed.issue.title,
          outcome: 'pass',
          totalTokens,
        });
      } else {
        if (!isRetriableMergeFailure(completed.result.error)) {
          skippedIssues.add(completed.issue.number);
        }
        results.push({
          issue: completed.issue.number,
          title: completed.issue.title,
          outcome: 'fail',
          error: completed.result.error,
          totalTokens,
        });
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  printAutoSummary(results);
  if (allUnblockAttempts.length > 0) {
    printUnblockSummary(allUnblockAttempts, homeDir);
  }
  if (results.length > 0) {
    logger.log('\n  Log files:');
    for (const result of results) {
      const logFile = logFiles.get(result.issue);
      if (!logFile) continue;
      logger.log(`  #${result.issue}   ${formatLogDisplayPath(logFile, homeDir)}`);
    }
  }
  if (results.some((result) => result.outcome === 'fail')) {
    process.exitCode = 1;
  }
  return;
}

async function attachIssueTotalTokens(
  repo: string,
  issue: string,
  since: Date,
  result: ShipIssueResult
): Promise<ShipIssueResult> {
  const totalTokens = await resolveIssueTotalTokens(repo, issue, since);
  return totalTokens === undefined ? result : { ...result, totalTokens };
}

async function resolveIssueTotalTokens(
  repo: string,
  issue: string,
  since: Date
): Promise<number | undefined> {
  try {
    const usage = await aggregateSessionUsage(repo, issue, since);
    return usage ? getTotalTokens(usage) : undefined;
  } catch {
    logger.warn(`Failed to resolve total tokens for issue #${issue}`);
    return undefined;
  }
}

export async function shipCommand(
  repo: string,
  issue: string | undefined,
  options: ShipOptions = { merge: false, auto: false }
): Promise<void> {
  if (options.auto) {
    const parallel = options.parallel ?? 0;
    if (parallel >= 2) {
      await shipAutoParallel(repo, parallel, options.agent, options.model);
      return;
    }

    await shipAutoSequential(repo, options.agent, options.model);
    return;
  }

  // Non-auto path: issue is required (validated in index.ts)
  if (!issue) {
    throw new Error('Error: an issue number is required unless --auto is used.');
  }
  const homeDir = homedir();
  const logsDir = path.join(homeDir, '.shipper', 'logs');
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(logsDir, `ship-${issue.replace(/^#/, '')}-${formatLogTimestamp()}.log`);
  const result = await shipOneIssue(
    repo,
    issue,
    options.merge,
    options.mode,
    options.agent,
    options.model,
    undefined,
    logFile
  );
  logger.log(`\nLog file: ${formatLogDisplayPath(logFile, homeDir)}`);
  if (!result.success) {
    process.exitCode = 1;
  }
}
