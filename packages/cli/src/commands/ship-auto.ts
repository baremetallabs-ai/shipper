import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger, releaseIssueLock } from '@dnsquared/shipper-core';
import type { AgentName } from '@dnsquared/shipper-core';
import {
  attemptUnblock,
  printUnblockSummary,
  selectBlockedIssues,
  selectNextCandidate,
} from './ship-candidates.js';
import type { UnblockAttempt } from './ship-candidates.js';
import {
  formatLogDisplayPath,
  formatLogTimestamp,
  resolveIssueTotalTokens,
  shipOneIssue,
} from './ship-execute.js';
import type { ParkHooks, ParkRequest, ReadyCheck, ShipIssueResult } from './ship-execute.js';
import { isRetriableMergeFailure } from './ship-merge.js';

const PARKED_POLL_INTERVAL_MS = 20_000;
const tokenFormatter = new Intl.NumberFormat('en-US');

export interface AutoResult {
  issue: number;
  title: string;
  outcome: 'pass' | 'fail';
  error?: string;
  totalTokens?: number;
}

interface AsyncIssueRun {
  child: ChildProcess;
  result: Promise<ShipIssueResult>;
}

interface WorkerRunMessage {
  type: 'run';
  repo: string;
  issue: string;
  agent?: AgentName;
  model?: string;
  disableMcp?: boolean;
  logFile?: string;
}

interface WorkerResultMessage extends ShipIssueResult {
  type: 'result';
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

export function resolveWorkerPath(
  entrypoint = process.argv[1],
  moduleUrl = import.meta.url
): string {
  if (entrypoint) {
    const entrypointPath = path.resolve(entrypoint);
    const extension = path.extname(entrypointPath) === '.ts' ? '.ts' : '.js';
    return path.join(path.dirname(entrypointPath), `ship-worker${extension}`);
  }

  const modulePath = fileURLToPath(moduleUrl);
  const extension = path.extname(modulePath) === '.ts' ? '.ts' : '.js';
  return path.resolve(path.dirname(modulePath), `../ship-worker${extension}`);
}

function isWorkerResultMessage(message: unknown): message is WorkerResultMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    Reflect.get(message, 'type') === 'result' &&
    typeof Reflect.get(message, 'success') === 'boolean'
  );
}

function shipOneIssueAsync(
  issue: string,
  repo: string,
  logFile?: string,
  agent?: AgentName,
  model?: string,
  disableMcp?: boolean
): AsyncIssueRun {
  const child = fork(resolveWorkerPath(), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (chunk: Buffer | string) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    process.stderr.write(chunk);
  });

  const result = new Promise<ShipIssueResult>((resolve) => {
    let settled = false;

    const resolveResult = (value: ShipIssueResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.on('message', (message) => {
      if (!isWorkerResultMessage(message)) {
        resolveResult({ success: false, error: 'worker returned an invalid IPC payload' });
        return;
      }
      resolveResult({
        success: message.success,
        ...(message.error !== undefined ? { error: message.error } : {}),
        ...(message.retriable !== undefined ? { retriable: message.retriable } : {}),
        ...(message.totalTokens !== undefined ? { totalTokens: message.totalTokens } : {}),
      });
    });

    child.on('error', (error) => {
      resolveResult({ success: false, error: error.message });
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      if (signal) {
        resolveResult({ success: false, error: `child exited from signal ${signal}` });
        return;
      }
      resolveResult({ success: false, error: `child exited with code ${code ?? 'unknown'}` });
    });

    const message: WorkerRunMessage = {
      type: 'run',
      repo,
      issue,
      ...(agent !== undefined ? { agent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(disableMcp !== undefined ? { disableMcp } : {}),
      ...(logFile !== undefined ? { logFile } : {}),
    };
    child.send(message);
  });

  return { child, result };
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
  model?: string,
  disableMcp?: boolean
): SequentialIssueRun {
  const parkObserver = createParkObserver(shouldPark);
  const completion = shipOneIssue({
    repo,
    issue: String(issue.number),
    merge: true,
    agent,
    model,
    disableMcp,
    parkHooks: parkObserver.hooks,
    logFile,
  }).finally(() => {
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

async function waitForReadyParked(
  parked: readonly ParkedIssue[],
  shouldStop: () => boolean,
  shutdownPromise: Promise<void>
): Promise<ParkedIssue | null> {
  for (;;) {
    if (shouldStop()) {
      return null;
    }
    const ready = await pollReadyParked(parked);
    if (ready) {
      return ready;
    }
    await Promise.race([wait(PARKED_POLL_INTERVAL_MS), shutdownPromise]);
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

export async function shipAutoSequential(
  repo: string,
  agent?: AgentName,
  model?: string,
  disableMcp?: boolean
): Promise<void> {
  const skippedIssues = new Set<number>();
  const results: AutoResult[] = [];
  const allUnblockAttempts: UnblockAttempt[] = [];
  const parked: ParkedIssue[] = [];
  const homeDir = homedir();
  const logsDir = path.join(homeDir, '.shipper', 'logs');
  const logFiles = new Map<number, string>();
  let shuttingDown = false;
  const isShuttingDown = (): boolean => shuttingDown;
  let resolveShutdown!: () => void;
  const shutdownPromise = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const onSignal = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    resolveShutdown();
  };

  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const shouldParkCurrentIssue = async (): Promise<boolean> => {
      if (isShuttingDown()) {
        return false;
      }
      if (parked.length > 0) {
        return true;
      }
      return (await selectNextCandidate(repo, skippedIssues)) !== null;
    };

    for (;;) {
      if (isShuttingDown()) {
        break;
      }

      // Inner loop: process all available candidates
      for (;;) {
        if (isShuttingDown()) {
          break;
        }

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
          model,
          disableMcp
        );
        const outcome = await waitForCompletionOrPark(run);
        if (outcome.type === 'parked') {
          parked.push(outcome.parked);
        } else {
          recordAutoResult(results, skippedIssues, candidate, outcome.result);
        }
      }

      if (isShuttingDown()) {
        break;
      }

      // Unblock pass
      const blocked = await selectBlockedIssues(repo);
      if (blocked.length === 0) {
        if (parked.length === 0) {
          break;
        }

        const readyParked = await waitForReadyParked(parked, isShuttingDown, shutdownPromise);
        if (!readyParked) {
          break;
        }
        await resumeParkedIssue(parked, readyParked, results, skippedIssues);
        continue;
      }

      let progress = false;
      for (const issue of blocked) {
        if (isShuttingDown()) {
          break;
        }
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
          disableMcp,
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

        const readyParked = await waitForReadyParked(parked, isShuttingDown, shutdownPromise);
        if (!readyParked) {
          break;
        }
        await resumeParkedIssue(parked, readyParked, results, skippedIssues);
        continue;
      }
      // Loop back — newly unblocked issues are now eligible candidates
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
  if (results.some((result) => result.outcome === 'fail') || isShuttingDown()) {
    process.exitCode = 1;
  }
}

export async function shipAutoParallel(
  repo: string,
  parallel: number,
  agent?: AgentName,
  model?: string,
  disableMcp?: boolean
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

  const handleSignal = (signal: ShipSignal) => {
    if (isShuttingDown()) return;
    shuttingDown = true;

    void (async () => {
      for (const run of activeRuns.values()) {
        run.child.kill(signal);
      }

      await wait(3000);

      for (const run of activeRuns.values()) {
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

  const onSigint = () => {
    handleSignal('SIGINT');
  };
  const onSigterm = () => {
    handleSignal('SIGTERM');
  };

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

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
        const run = shipOneIssueAsync(
          String(candidate.number),
          repo,
          logFile,
          agent,
          model,
          disableMcp
        );
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
            disableMcp,
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
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
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
}
