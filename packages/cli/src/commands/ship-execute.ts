import { spawn } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
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
  withIssueLock,
  STAGE_NAME_MAP,
  NEW_LABEL,
  PR_REVIEWED_LABEL,
  PRIORITY_LABEL_NAMES,
  READY_LABEL,
  BLOCKED_LABEL,
  LOCKED_LABEL,
  FAILED_LABEL,
  type QueuedPR,
} from '@dnsquared/shipper-core';
import type { AgentName, CommandMode, Logger } from '@dnsquared/shipper-core';
import { buildReadyCheck, SKIP_PR_REMEDIATE_WAIT_ENV_VAR } from './pr-remediate.js';
import { isRetriableMergeFailure, mergePr, resolvePrForIssue } from './ship-merge.js';

const MAX_TRANSITIONS = 15;
export const AUTO_CHILD_RUN_ENV_VAR = 'SHIPPER_AUTO_CHILD_RUN';

export const STAGE_NAME: Record<string, string> = { ...STAGE_NAME_MAP };

const STAGE_MODE_KEY: Record<string, string> = {
  'pr open': 'pr_open',
  'pr review': 'pr_review',
  'pr remediate': 'pr_remediate',
};

interface StageResult {
  stage: string;
  status: 'pass' | 'fail';
}

export interface ShipIssueResult {
  success: boolean;
  error?: string;
  retriable?: boolean;
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

export function summarizeChildStderr(stderrOutput: string): string {
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

export async function shipOneIssue(
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

          if (label === NEW_LABEL && previousLabel !== NEW_LABEL && (parkHooks || isAutoChildRun)) {
            const msg = `Issue #${issueStr} was reset to ${NEW_LABEL} by stage "${stageName}" - stopping to avoid interactive groom stage.`;
            issueLogger.error(msg);
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
