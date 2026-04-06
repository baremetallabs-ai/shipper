import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
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
  AUTO_CHILD_RUN_ENV_VAR,
  closeLogStream,
  formatLogDisplayPath,
  formatLogTimestamp,
  resolveIssueTotalTokens,
  shipOneIssue,
  summarizeChildStderr,
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
  let logStreamClosed = false;
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

  const closeChildLogStream = (destroy = false): Promise<void> => {
    if (!logStream || logStreamClosed || logStream.destroyed || logStreamError) {
      return Promise.resolve();
    }
    logStreamClosed = true;

    if (!destroy) {
      return closeLogStream(logStream).catch(() => undefined);
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      logStream.once('close', finish);
      logStream.once('error', finish);
      logStream.destroy();
    });
  };

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

    const resolveResult = (value: ShipIssueResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.on('error', (error) => {
      void closeChildLogStream(true).finally(() => {
        resolveResult({ success: false, error: error.message });
      });
    });

    child.on('close', (code, signal) => {
      void closeChildLogStream().finally(() => {
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

export async function shipAutoSequential(
  repo: string,
  agent?: AgentName,
  model?: string
): Promise<void> {
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
}

export async function shipAutoParallel(
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
}
