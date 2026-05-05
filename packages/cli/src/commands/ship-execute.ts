import type { WriteStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import {
  aggregateSessionUsage,
  createLogger,
  getSettings,
  gh,
  logger,
  resolveMode,
  toError,
  toErrorMessage,
  totalTokens as getTotalTokens,
  withLogCapture,
  withIssueLock,
  STAGE_NAME_MAP,
  NEW_LABEL,
  FAILED_LABEL,
  PR_REVIEWED_LABEL,
  READY_LABEL,
  type QueuedPR,
} from '@baremetallabs-ai/shipper-core';
import type { AgentName, CommandMode, Logger } from '@baremetallabs-ai/shipper-core';
import { buildReadyCheck } from './pr-remediate.js';
import { isRetriableMergeFailure, mergePr, resolvePrForIssue } from './ship-merge.js';
import { runStageForLabel } from './stage-dispatch.js';
import { getCurrentWorkflowLabel } from './workflow-label.js';

const MAX_TRANSITIONS = 15;

export const STAGE_NAME: Record<string, string> = { ...STAGE_NAME_MAP };

const STAGE_MODE_KEY: Record<string, string> = {
  'pr open': 'pr_open',
  'pr review': 'pr_review',
  'pr remediate': 'pr_remediate',
};

interface StageResult {
  stage: string;
  status: 'pass' | 'fail' | 'reject';
  rolledBackTo?: string;
}

export interface ShipOneIssueOptions {
  repo: string;
  issue: string;
  merge: boolean;
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
  disableMcp?: boolean;
  parkHooks?: ParkHooks;
  pauseProbe?: () => boolean | Promise<boolean>;
  logFile?: string;
  skipInteractiveStages?: boolean;
  collectTokens?: boolean;
}

export interface ShipIssueResult {
  success: boolean;
  error?: string;
  retriable?: boolean;
  paused?: boolean;
  totalTokens?: number;
}

export type ReadyCheck = () => Promise<boolean>;

export interface ParkRequest {
  readyCheck: ReadyCheck;
  resume: () => void;
}

export interface ParkHooks {
  shouldPark: () => Promise<boolean>;
  park: (request: ParkRequest) => void;
}

function getStageModeKey(stageName: string): string {
  return STAGE_MODE_KEY[stageName] ?? stageName;
}

export function formatLogTimestamp(date = new Date()): string {
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

export function formatLogDisplayPath(logFile: string, homeDir = homedir()): string {
  return logFile.startsWith(homeDir) ? `~${logFile.slice(homeDir.length)}` : logFile;
}

export function closeLogStream(logStream: WriteStream | undefined): Promise<void> {
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

function printSummary(results: StageResult[], issueLogger: Logger): void {
  issueLogger.log('\nStage summary:');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : r.status === 'reject' ? '↻' : '✗';
    const suffix =
      r.status === 'fail'
        ? ' — failed'
        : r.status === 'reject'
          ? ` — rejected${r.rolledBackTo ? ` to ${r.rolledBackTo}` : ''}`
          : '';
    issueLogger.log(`  ${icon} ${r.stage}${suffix}`);
  }
}

export async function shipOneIssue(options: ShipOneIssueOptions): Promise<ShipIssueResult> {
  const {
    repo,
    issue,
    merge,
    mode,
    agent,
    model,
    disableMcp,
    parkHooks,
    pauseProbe,
    logFile,
    skipInteractiveStages = false,
    collectTokens = true,
  } = options;
  const issueStr = issue.replace(/^#/, '');
  const issueStartTime = new Date();
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
    const result = await withLogCapture(
      logStream,
      async () =>
        await withIssueLock(repo, issueStr, async () => {
          let label = await getCurrentWorkflowLabel(repo, issueStr);

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

            for (;;) {
              const stageName = STAGE_NAME[label];
              if (!stageName) {
                const msg = `Unrecognized shipper label "${label}" on issue #${issueStr}.`;
                issueLogger.error(msg);
                printSummary(results, issueLogger);
                return { success: false, error: msg };
              }

              if (await pauseProbe?.()) {
                issueLogger.log(`Paused at stage boundary before "${stageName}"`);
                printSummary(results, issueLogger);
                return { success: true, paused: true };
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
              if (skipInteractiveStages && stageMode === 'interactive') {
                issueLogger.log(
                  `Skipping issue #${issueStr}: stage "${stageName}" requires interactive mode.`
                );
                return { success: true };
              }

              issueLogger.log(`Running stage: ${stageName}`);
              const stageResult = await runStageForLabel(repo, issueStr, label, {
                mode: stageMode,
                agent,
                model,
                disableMcp,
                skipInitialPrRemediateWait: label === PR_REVIEWED_LABEL && skipPrRemediateWaitOnce,
              });
              skipPrRemediateWaitOnce = false;

              if (logStreamError) {
                return failCurrentStage(stageName, logStreamError);
              }

              if (!stageResult.success && stageResult.verdict !== 'reject') {
                results.push({ stage: stageName, status: 'fail' });
                printSummary(results, issueLogger);
                return {
                  success: false,
                  error: stageResult.error ?? `stage "${stageName}" failed`,
                };
              }

              label = await getCurrentWorkflowLabel(repo, issueStr);
              const stageSummary: StageResult =
                stageResult.verdict === 'reject'
                  ? { stage: stageName, status: 'reject', rolledBackTo: label }
                  : { stage: stageName, status: 'pass' };
              results.push(stageSummary);

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
                printSummary(results, issueLogger);
                if (parkHooks || skipInteractiveStages) {
                  const msg = `Issue #${issueStr} rolled back to ${NEW_LABEL} after stage "${stageName}" - stopping to avoid interactive groom stage.`;
                  issueLogger.error(msg);
                  return { success: false, error: msg };
                }
                issueLogger.log(
                  `Issue #${issueStr} rolled back to ${NEW_LABEL} after stage "${stageName}". Re-invoke after grooming.`
                );
                return { success: true };
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
              await mergePr(pr, issueNumber, nwo, issueLogger, logStream);
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
        })
    );
    if (!collectTokens) {
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

async function attachIssueTotalTokens(
  repo: string,
  issue: string,
  since: Date,
  result: ShipIssueResult
): Promise<ShipIssueResult> {
  const totalTokens = await resolveIssueTotalTokens(repo, issue, since);
  return totalTokens === undefined ? result : { ...result, totalTokens };
}

export async function resolveIssueTotalTokens(
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
