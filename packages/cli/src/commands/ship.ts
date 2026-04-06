import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger } from '@dnsquared/shipper-core';
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
