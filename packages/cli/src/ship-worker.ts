import type { AgentName } from '@dnsquared/shipper-core';
import { shipOneIssue } from './commands/ship-execute.js';

interface WorkerRunMessage {
  type: 'run';
  repo: string;
  issue: string;
  agent?: AgentName;
  model?: string;
  logFile?: string;
}

interface WorkerResultMessage {
  type: 'result';
  success: boolean;
  error?: string;
  retriable?: boolean;
  totalTokens?: number;
}

/*
IPC protocol:
- Parent -> child: { type: 'run', repo, issue, agent?, model?, logFile? }
- Child -> parent: { type: 'result', success, error?, retriable?, totalTokens? }
The worker owns its ship log file and no SHIPPER_* env vars cross this boundary.
*/

function isWorkerRunMessage(message: unknown): message is WorkerRunMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    Reflect.get(message, 'type') === 'run' &&
    typeof Reflect.get(message, 'repo') === 'string' &&
    typeof Reflect.get(message, 'issue') === 'string'
  );
}

async function sendResult(message: WorkerResultMessage, exitCode: number): Promise<void> {
  if (typeof process.send !== 'function') {
    process.exit(exitCode);
  }

  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  process.exit(exitCode);
}

let handled = false;

process.on('message', (message) => {
  if (handled) {
    return;
  }
  handled = true;

  void (async () => {
    if (!isWorkerRunMessage(message)) {
      await sendResult(
        {
          type: 'result',
          success: false,
          error: 'worker received an invalid run payload',
        },
        1
      );
      return;
    }

    try {
      const result = await shipOneIssue({
        repo: message.repo,
        issue: message.issue,
        merge: true,
        agent: message.agent,
        model: message.model,
        logFile: message.logFile,
        skipInteractiveStages: true,
        collectTokens: false,
      });
      await sendResult(
        {
          type: 'result',
          success: result.success,
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(result.retriable !== undefined ? { retriable: result.retriable } : {}),
          ...(result.totalTokens !== undefined ? { totalTokens: result.totalTokens } : {}),
        },
        result.success ? 0 : 1
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await sendResult({ type: 'result', success: false, error: detail }, 1);
    }
  })();
});
