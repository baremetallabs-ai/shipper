import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger, PAUSED_EXIT_CODE, RETRIABLE_FAILURE_EXIT_CODE } from '@dnsquared/shipper-core';
import type { AgentName, CommandMode } from '@dnsquared/shipper-core';
import { shipAutoParallel, shipAutoSequential } from './ship-auto.js';
import { formatLogDisplayPath, formatLogTimestamp, shipOneIssue } from './ship-execute.js';

interface ShipOptions {
  merge: boolean;
  auto: boolean;
  parallel?: number;
  mode?: CommandMode;
  agent?: AgentName;
  model?: string;
  disableMcp?: boolean;
}

export async function shipCommand(
  repo: string,
  issue: string | undefined,
  options: ShipOptions = { merge: false, auto: false }
): Promise<void> {
  if (options.auto) {
    const parallel = options.parallel ?? 0;
    if (parallel >= 2) {
      await shipAutoParallel(repo, parallel, options.agent, options.model, options.disableMcp);
      return;
    }

    await shipAutoSequential(repo, options.agent, options.model, options.disableMcp);
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
  const pauseSentinelPath = process.env.SHIPPER_PAUSE_SENTINEL_FILE;
  const result = await shipOneIssue({
    repo,
    issue,
    merge: options.merge,
    mode: options.mode,
    agent: options.agent,
    model: options.model,
    disableMcp: options.disableMcp,
    pauseProbe: pauseSentinelPath ? () => existsSync(pauseSentinelPath) : undefined,
    logFile,
  });
  logger.log(`\nLog file: ${formatLogDisplayPath(logFile, homeDir)}`);
  if (result.paused) {
    process.exitCode = PAUSED_EXIT_CODE;
  } else if (result.retriable) {
    process.exitCode = RETRIABLE_FAILURE_EXIT_CODE;
  } else if (!result.success) {
    process.exitCode = 1;
  }
}
