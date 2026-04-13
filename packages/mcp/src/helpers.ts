import { spawn } from 'node:child_process';
import { toErrorMessage } from '@dnsquared/shipper-core';

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ToolTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export async function spawnShipper(
  args: string[],
  opts: { timeoutMs: number }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('shipper', args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export function formatToolError(error: unknown): ToolTextResult {
  return {
    content: [{ type: 'text', text: toErrorMessage(error) }],
    isError: true,
  };
}

export function formatSpawnResult(result: SpawnResult, command: string): ToolTextResult {
  const parts: string[] = [];
  if (result.timedOut) {
    parts.push(`[timed out] ${command}`);
  } else {
    parts.push(`[exit ${result.exitCode}] ${command}`);
  }
  if (result.stdout.trim().length > 0) {
    parts.push('--- stdout ---', result.stdout.trimEnd());
  }
  if (result.stderr.trim().length > 0) {
    parts.push('--- stderr ---', result.stderr.trimEnd());
  }
  const text = parts.join('\n');
  const isError = result.timedOut || result.exitCode !== 0;
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}
